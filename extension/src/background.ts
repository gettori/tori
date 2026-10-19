import { SPACE_COLORS, spaceHue } from "../../src/utils/spaceTint";
import { dropImage, dropImages, getImage, putImage } from "./images";
import { batchToMarkdown } from "./markdown";
import type {
  BatchRequest,
  Chat,
  ConnectionRequest,
  LogEntry,
  Pick,
  PickerRequest,
  Rect,
  Sent,
  Shot,
  TrayState,
} from "./pick";
import { pickShortcut } from "./shortcut";
import {
  CLOSED,
  GROUPS_KEY,
  LOG_KEY,
  NOT_RUNNING,
  NOT_SET_UP,
  NOT_WORKTREE,
  SHOTS_KEY,
  sentenceOf,
  label,
  type GroupColor,
  type TabState,
  type Unit,
} from "./tab";

type Reply = { id: number; result?: unknown; error?: { message: string } };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const GROUP_COLORS: Record<string, GroupColor> = {
  Amber: "orange",
  Coral: "red",
  Rose: "red",
  Magenta: "pink",
  Violet: "purple",
  Indigo: "blue",
  Sky: "blue",
  Teal: "cyan",
  Emerald: "green",
  Lime: "green",
  Gold: "yellow",
  Slate: "grey",
};

// Close to what Chrome paints each group colour, so the dot matches the group.
const BADGE_HEX: Record<GroupColor, string> = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e",
};

let port: chrome.runtime.Port | null = null;
let lastId = 0;
const waiting = new Map<number, (reply: Omit<Reply, "id">) => void>();

function drop(closing: chrome.runtime.Port) {
  closing.disconnect();
  if (port === closing) port = null;
}

function open(): chrome.runtime.Port {
  if (port) return port;
  const opened = chrome.runtime.connectNative(__HOST__);
  opened.onMessage.addListener((reply: Reply) => {
    // The host exits after this reply; the retry must not post to it.
    if (reply.error?.message === CLOSED) drop(opened);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  opened.onDisconnect.addListener(() => {
    // Chrome says "not found" with no host manifest and "forbidden" when the
    // manifest names another extension id.
    const why = chrome.runtime.lastError?.message ?? "";
    const message = /not found|forbidden/i.test(why) ? NOT_SET_UP : NOT_RUNNING;
    if (port === opened) port = null;
    for (const done of waiting.values()) done({ error: { message } });
    waiting.clear();
  });
  return (port = opened);
}

type TabTag = { id: number; url: string };

// The host answers its last frame with CLOSED and exits; a fresh one says why.
async function call(method: string, params: object, tab?: TabTag): Promise<unknown> {
  try {
    return await send(method, params, tab);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== CLOSED) throw e;
    return send(method, params, tab);
  }
}

function send(method: string, params: object, tab?: TabTag): Promise<unknown> {
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    waiting.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result)));
    try {
      open().postMessage({ jsonrpc: "2.0", id, method, params, tab });
    } catch {
      // The host went away before onDisconnect ran.
      port = null;
      waiting.delete(id);
      reject(new Error(NOT_RUNNING));
    }
  });
}

function localPort(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname) && u.port
      ? Number(u.port)
      : null;
  } catch {
    return null;
  }
}

function groupColor(unit: Unit): GroupColor {
  const hue = spaceHue(unit.space, unit.space_color);
  return GROUP_COLORS[SPACE_COLORS.find((c) => c.hex === hue)?.name ?? ""] ?? "grey";
}

async function describe(tab: chrome.tabs.Tab): Promise<TabState> {
  const at = localPort(tab.url);
  if (at === null) return { kind: "other", title: NOT_WORKTREE };
  try {
    const unit = (await call("worktree.at", { port: at })) as Unit | null;
    if (!unit) return { kind: "other", title: NOT_WORKTREE };
    return { kind: "worktree", unit, color: groupColor(unit) };
  } catch (e) {
    return { kind: "other", title: e instanceof Error ? e.message : String(e) };
  }
}

async function show(tabId: number, state: TabState) {
  if (state.kind === "other") {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: sentenceOf(state.title) });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_HEX[state.color] });
  await chrome.action.setBadgeText({ tabId, text: " " });
  await chrome.action.setTitle({ tabId, title: `${label(state.unit)}, ${state.unit.name}` });
}

const GROUP_MS = 2000;
const TIMED_OUT = Symbol("timed out");

// Arc has the tab groups API but never answers it; one silence turns grouping
// off until the worker restarts, so the queue behind it keeps moving.
let grouping = true;

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(TIMED_OUT), ms))]);
}

async function join(tabId: number, windowId: number, title: string, color: GroupColor) {
  const groups = await chrome.tabGroups.query({ windowId });
  const existing = groups.find((g) => g.title === title);
  if (existing) {
    await chrome.tabs.group({ groupId: existing.id, tabIds: tabId });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title, color });
}

// Only a tab in no group: one the person grouped themselves stays where it is.
async function group(tab: chrome.tabs.Tab, state: TabState) {
  if (!grouping || state.kind !== "worktree" || tab.id === undefined) return;
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  const stored = await chrome.storage.local.get(GROUPS_KEY);
  if (stored[GROUPS_KEY] === false) return;
  try {
    await within(GROUP_MS, join(tab.id, tab.windowId, label(state.unit), state.color));
  } catch (e) {
    if (e !== TIMED_OUT) throw e;
    grouping = false;
  }
}

async function mark(tab: chrome.tabs.Tab): Promise<TabState | null> {
  if (tab.id === undefined) return null;
  const state = await describe(tab);
  await show(tab.id, state);
  return state;
}

async function refresh(tab: chrome.tabs.Tab): Promise<TabState | null> {
  const state = await mark(tab);
  if (state) await group(tab, state);
  return state;
}

// One tab at a time, so two tabs of a new branch land in one group, not two.
let queue: Promise<unknown> = Promise.resolve();
function enqueue(tab: chrome.tabs.Tab): Promise<TabState | null> {
  const next = queue.then(() => refresh(tab));
  queue = next.catch(() => {});
  return next;
}

async function refreshAll() {
  for (const tab of await chrome.tabs.query({})) void enqueue(tab);
}

const batchKey = (tabId: number) => `batch:${tabId}`;

type Batch = { worktree: string; picks: Pick[] };

async function batch(tabId: number): Promise<Batch | undefined> {
  const key = batchKey(tabId);
  return (await chrome.storage.session.get(key))[key] as Batch | undefined;
}

async function dropBatch(tabId: number) {
  await chrome.storage.session.remove(batchKey(tabId));
  await dropImages(tabId);
}

// `undefined` when Tori could not answer, which is no reason to drop a batch.
async function worktreeOf(tab: chrome.tabs.Tab): Promise<string | null | undefined> {
  const state = await describe(tab);
  if (state.kind === "worktree") return state.unit.folder;
  return state.title === NOT_WORKTREE ? null : undefined;
}

// The inspect script reads the page's own properties, so it goes in the main world,
// first, and only on a worktree's page.
async function inject(tabId: number, inspect = true) {
  if (inspect) await chrome.scripting.executeScript({ target: { tabId }, files: ["inspect.js"], world: "MAIN" });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["picker.js"] });
}

async function togglePicker(tab: chrome.tabs.Tab) {
  if (tab.id === undefined || (await describe(tab)).kind !== "worktree") return;
  await inject(tab.id);
  const message: PickerRequest = { type: "picker.toggle" };
  await chrome.tabs.sendMessage(tab.id, message);
}

// Any page the click grants, so the tray can say why there is nothing to pick there.
async function openTray(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return;
  await inject(tab.id, (await describe(tab)).kind === "worktree");
  const message: PickerRequest = { type: "picker.open" };
  await chrome.tabs.sendMessage(tab.id, message);
}

const screenshotsOn = async () => (await chrome.storage.local.get(SHOTS_KEY))[SHOTS_KEY] !== false;
const pageLogOn = async () => (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] !== false;

const PAGE_LOG = "pagelog";

async function registerPageLog() {
  const on = await pageLogOn();
  const there = (await chrome.scripting.getRegisteredContentScripts({ ids: [PAGE_LOG] })).length > 0;
  if (on && !there) {
    await chrome.scripting.registerContentScripts([
      {
        id: PAGE_LOG,
        js: ["pagelog.js"],
        matches: chrome.runtime.getManifest().host_permissions ?? [],
        runAt: "document_start",
        world: "MAIN",
      },
    ]);
  } else if (!on && there) await chrome.scripting.unregisterContentScripts({ ids: [PAGE_LOG] });
}

// Install, startup and the switch can land together; two checks at once would both register.
let registering: Promise<unknown> = Promise.resolve();
function syncPageLog() {
  registering = registering.then(registerPageLog).catch((e: unknown) => console.error("page log registration", e));
}

// A reload ends pick mode but keeps the batch, so its tray comes back.
async function restore(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return;
  const held = await batch(tab.id);
  if (!held) return;
  const now = await worktreeOf(tab);
  if (now === undefined || now === held.worktree) await inject(tab.id);
  else await dropBatch(tab.id);
}

const IMAGES_PER_SEND = 10;
const JPEG_QUALITY = 0.85;
const UPLOAD_CHUNK = 144 * 1024;

function encode(bitmap: ImageBitmap, r: Rect, type: string, quality?: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(r.width, r.height);
  canvas.getContext("2d")!.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return canvas.convertToBlob({ type, quality });
}

async function shoot(tab: chrome.tabs.Tab, rect: Rect, viewport: number): Promise<Shot> {
  if (!(await screenshotsOn())) return { images: [], why: "screenshots are off in the options" };
  const held = await batch(tab.id!);
  const taken = held?.picks.reduce((n, p) => n + p.images.length, 0) ?? 0;
  if (taken + 2 > IMAGES_PER_SEND) return { images: [], why: `${IMAGES_PER_SEND} screenshots per send` };
  let png: string;
  try {
    png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    return { images: [], why: "press the shortcut or click Tori again to take screenshots" };
  }
  const bitmap = await createImageBitmap(await (await fetch(png)).blob());
  const scale = bitmap.width / viewport;
  const x = Math.max(0, Math.round(rect.x * scale));
  const y = Math.max(0, Math.round(rect.y * scale));
  const crop = {
    x,
    y,
    width: Math.max(1, Math.min(bitmap.width - x, Math.round(rect.width * scale))),
    height: Math.max(1, Math.min(bitmap.height - y, Math.round(rect.height * scale))),
  };
  const seq = `${tab.id}:${Date.now().toString(36)}`;
  const whole = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
  await putImage(`${seq}:viewport`, await encode(bitmap, whole, "image/jpeg", JPEG_QUALITY));
  await putImage(`${seq}:element`, await encode(bitmap, crop, "image/png"));
  return { images: [`${seq}:viewport`, `${seq}:element`] };
}

async function chats(tab: chrome.tabs.Tab): Promise<Chat[]> {
  const rows = (await call("sessions.list", { live: true }, tagOf(tab))) as Record<string, unknown>[];
  return rows
    .filter((row) => row.chat === true)
    .map((row) => ({
      id: String(row.id),
      title: String(row.name || row.title || "New chat"),
      agent: String(row.agent ?? ""),
    }));
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

async function upload(key: string, tab: TabTag): Promise<string> {
  const blob = await getImage(key);
  if (!blob) throw new Error("a screenshot went missing; pick it again");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const name = `${key.split(":").pop()}.${blob.type === "image/png" ? "png" : "jpg"}`;
  let id: string | undefined;
  for (let at = 0; ; at += UPLOAD_CHUNK) {
    const last = at + UPLOAD_CHUNK >= bytes.length;
    const data = base64(bytes.subarray(at, at + UPLOAD_CHUNK));
    const done = (await call("attachment.write", { name, data, upload: id, last }, tab)) as {
      upload?: string;
      path?: string;
    };
    if (last) return done.path!;
    id = done.upload;
  }
}

// No chat opens a new chat draft in Tori, which the person sends from there.
async function sendBatch(tab: chrome.tabs.Tab, chat: Chat | null, log: LogEntry[]): Promise<Sent> {
  const held = await batch(tab.id!);
  const picks = held?.picks ?? [];
  const said = (await pageLogOn()) ? log : [];
  if (!picks.length && !said.length)
    return { error: log.length ? "the page log is off in the options" : "nothing picked" };
  const tag = tagOf(tab);
  try {
    const pending = chat ? ((await call("session.pending", { id: chat.id }, tag)) as unknown[]) : [];
    if (chat && pending.length) return { error: `${chat.title} is waiting on you in Tori; answer it first` };
    if (!chat) await call("chat.draft", { text: "", check: true }, tag);
    const attach: string[] = [];
    for (const key of picks.flatMap((p) => p.images)) attach.push(await upload(key, tag));
    const text = batchToMarkdown(picks, true, said, held?.worktree);
    if (chat) await call("session.steer", { id: chat.id, text, attach }, tag);
    else await call("chat.draft", { text, attach }, tag);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  await dropBatch(tab.id!);
  return { title: chat?.title ?? "a new chat", logged: said.length > 0 };
}

async function opened(tab: chrome.tabs.Tab & { id: number }): Promise<TrayState> {
  const state = await describe(tab);
  return {
    picks: (await batch(tab.id))?.picks ?? [],
    branch: state.kind === "worktree" ? label(state.unit) : "",
    shortcut: await pickShortcut(),
    status: state.kind === "worktree" ? null : sentenceOf(state.title),
    screenshots: await screenshotsOn(),
    pageLog: await pageLogOn(),
  };
}

async function removePick(tabId: number, index: number): Promise<Pick[]> {
  const held = await batch(tabId);
  if (!held) return [];
  const [gone] = held.picks.splice(index, 1);
  for (const key of gone?.images ?? []) await dropImage(key);
  if (held.picks.length) await chrome.storage.session.set({ [batchKey(tabId)]: held });
  else await chrome.storage.session.remove(batchKey(tabId));
  return held.picks;
}

const tagOf = (tab: chrome.tabs.Tab): TabTag => ({ id: tab.id!, url: tab.url ?? "" });

async function handle(message: BatchRequest, tab: chrome.tabs.Tab & { id: number }): Promise<unknown> {
  switch (message.type) {
    case "batch.get":
      return opened(tab);
    case "batch.add": {
      const held = await batch(tab.id);
      const worktree = (await worktreeOf(tab)) ?? held?.worktree;
      if (!worktree) return held?.picks ?? [];
      const picks = [...(held?.worktree === worktree ? held.picks : []), message.pick];
      const next: Batch = { worktree, picks };
      await chrome.storage.session.set({ [batchKey(tab.id)]: next });
      return picks;
    }
    case "batch.remove":
      return removePick(tab.id, message.index);
    case "batch.clear":
      return dropBatch(tab.id);
    case "shot":
      return shoot(tab, message.rect, message.viewport);
    case "markdown": {
      const held = await batch(tab.id);
      return batchToMarkdown(held?.picks ?? [], false, (await pageLogOn()) ? message.log : [], held?.worktree);
    }
    case "chats":
      return chats(tab);
    case "send":
      return sendBatch(tab, message.chat, message.log);
    case "reveal":
      return call("window.reveal", { id: message.id }, tagOf(tab)).then(
        () => ({}),
        (e: Error) => ({ error: e.message }),
      );
    case "options":
      return chrome.runtime.openOptionsPage();
    case "screenshots":
      return screenshotsOn();
  }
}

async function connection(): Promise<string | null> {
  try {
    await call("caller", {});
    return null;
  } catch (e) {
    return sentenceOf(e instanceof Error ? e.message : String(e));
  }
}

function answer(message: ConnectionRequest | BatchRequest, sender: chrome.runtime.MessageSender) {
  if (message.type === "connection") return connection();
  const tab = sender.tab;
  return tab?.id === undefined ? Promise.resolve(null) : handle(message, { ...tab, id: tab.id });
}

chrome.runtime.onInstalled.addListener(() => {
  void refreshAll();
  syncPageLog();
});
chrome.runtime.onStartup.addListener(() => {
  void refreshAll();
  syncPageLog();
});
chrome.storage.onChanged.addListener((change, area) => {
  if (area === "local" && LOG_KEY in change) syncPageLog();
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === "complete") void enqueue(tab);
  // Swallowed: the tab can close or navigate away before the script lands.
  if (change.status === "complete" && localPort(tab.url) !== null) void restore(tab).catch(() => {});
  else if (change.status === "complete") void dropBatch(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => void dropBatch(tabId));
// Swallowed: browser pages refuse every script, and the toolbar title already says why.
chrome.action.onClicked.addListener((tab) => void openTray(tab).catch(() => {}));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "pick" && tab) void togglePicker(tab);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  void answer(message, sender).then(reply, () => reply(null));
  return true;
});
