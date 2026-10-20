import { SPACE_COLORS, spaceHue } from "../../src/utils/spaceTint";
import { dropImage, dropImages, getImage, putImage } from "./images";
import { batchToMarkdown } from "./markdown";
import { LOG_PORT, PANEL_PORT } from "./pick";
import type {
  BatchRequest,
  Chat,
  ConnectionRequest,
  LogEntry,
  PanelIn,
  PanelOut,
  PanelRequest,
  PanelState,
  Pick,
  PickerRequest,
  Rect,
  Sent,
  Setup,
  Shot,
  TallyRequest,
  TrayState,
} from "./pick";
import { addressOf, keeperOf } from "./collapse";
import { pickShortcut } from "./shortcut";
import {
  CLOSED,
  GROUPS_KEY,
  LOG_KEY,
  NOT_RUNNING,
  NOT_SET_UP,
  NOT_WORKTREE,
  PROTOCOL,
  SHOTS_KEY,
  sentenceOf,
  label,
  localPort,
  type GroupColor,
  type TabState,
  type Unit,
} from "./tab";

type Reply = { id: number; result?: unknown; error?: { message: string } };

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
      open().postMessage({ jsonrpc: "2.0", id, method, params, tab, protocol: PROTOCOL });
    } catch {
      // The host went away before onDisconnect ran.
      port = null;
      waiting.delete(id);
      reject(new Error(NOT_RUNNING));
    }
  });
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

const worktreeKey = (tabId: number) => `worktree:${tabId}`;
const tallyKey = (tabId: number) => `tally:${tabId}`;
const BADGE_MAX = 999;

// The only badge writer. Two keys, not one record, so a tally and a refresh landing
// together cannot overwrite each other's half; kept in session storage since the worker sleeps.
async function paint(tabId: number) {
  const keys = [worktreeKey(tabId), tallyKey(tabId)];
  const stored = await chrome.storage.session.get(keys);
  const count = (await pageLogOn()) ? Number(stored[keys[1]] ?? 0) : 0;
  const number = count > BADGE_MAX ? `${BADGE_MAX}+` : count > 0 ? String(count) : " ";
  await chrome.action.setBadgeText({ tabId, text: stored[keys[0]] === true ? number : "" });
}

async function show(tabId: number, state: TabState) {
  await chrome.storage.session.set({ [worktreeKey(tabId)]: state.kind === "worktree" });
  if (state.kind === "other") {
    await paint(tabId);
    await chrome.action.setTitle({ tabId, title: sentenceOf(state.title) });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_HEX[state.color] });
  await paint(tabId);
  await chrome.action.setTitle({ tabId, title: `${label(state.unit)}, ${state.unit.name}` });
}

async function tallied(tabId: number, { count }: TallyRequest) {
  await chrome.storage.session.set({ [tallyKey(tabId)]: count });
  await paint(tabId);
}

async function paintAll() {
  for (const tab of await chrome.tabs.query({})) if (tab.id !== undefined) void paint(tab.id);
}

function forgetTab(tabId: number) {
  void dropBatch(tabId);
  void chrome.storage.session.remove([worktreeKey(tabId), tallyKey(tabId)]);
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

// The log runs in the page's world to see its errors; the relay runs in ours to reach the worker.
// Checked one by one, since an install from before the relay already has the log registered.
const PAGE_SCRIPTS = [
  { id: "pagelog", world: "MAIN" },
  { id: "pagerelay", world: "ISOLATED" },
] as const;

async function registerPageLog() {
  const on = await pageLogOn();
  const there = new Set<string>(
    (await chrome.scripting.getRegisteredContentScripts({ ids: PAGE_SCRIPTS.map((s) => s.id) })).map((s) => s.id),
  );
  const add = PAGE_SCRIPTS.filter((s) => on && !there.has(s.id));
  const drop = PAGE_SCRIPTS.filter((s) => !on && there.has(s.id)).map((s) => s.id);
  if (add.length) {
    await chrome.scripting.registerContentScripts(
      add.map(({ id, world }) => ({
        id,
        js: [`${id}.js`],
        matches: chrome.runtime.getManifest().host_permissions ?? [],
        runAt: "document_start",
        world,
      })),
    );
  }
  if (drop.length) await chrome.scripting.unregisterContentScripts({ ids: drop });
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

async function setupOf(tab: chrome.tabs.Tab): Promise<Setup | null> {
  const port = localPort(tab.url);
  if (port === null) return null;
  try {
    return (await call("web.setup", { port }, tagOf(tab))) as Setup | null;
  } catch {
    // Without it a pick only loses a hint and a path prefix; a send must not fail on it.
    return null;
  }
}

// No chat opens a new chat draft in Tori, which the person sends from there.
async function deliver(
  tab: chrome.tabs.Tab,
  chat: Chat | null,
  picks: Pick[],
  log: LogEntry[],
  worktree?: string,
): Promise<Sent> {
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
    const text = batchToMarkdown(picks, true, said, worktree, (await setupOf(tab))?.dir);
    if (chat) await call("session.steer", { id: chat.id, text, attach }, tag);
    else await call("chat.draft", { text, attach }, tag);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { title: chat?.title ?? "a new chat", logged: said.length > 0 };
}

async function sendBatch(tab: chrome.tabs.Tab, chat: Chat | null, log: LogEntry[]): Promise<Sent> {
  const held = await batch(tab.id!);
  const sent = await deliver(tab, chat, held?.picks ?? [], log, held?.worktree);
  if ("title" in sent) await dropBatch(tab.id!);
  return sent;
}

async function sendLog(tab: chrome.tabs.Tab, chat: Chat | null, log: LogEntry[]): Promise<Sent> {
  return deliver(tab, chat, [], log, (await batch(tab.id!))?.worktree);
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
      const log = (await pageLogOn()) ? message.log : [];
      return batchToMarkdown(held?.picks ?? [], false, log, held?.worktree, (await setupOf(tab))?.dir);
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
    case "setup":
      return setupOf(tab);
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

async function forPanel(message: PanelRequest): Promise<unknown> {
  const tab = await chrome.tabs.get(message.tabId);
  switch (message.type) {
    case "panel.state": {
      const state = await describe(tab);
      return (
        state.kind === "worktree"
          ? { worktree: label(state.unit), title: state.unit.name }
          : { worktree: null, title: sentenceOf(state.title) }
      ) satisfies PanelState;
    }
    case "panel.chats":
      return chats(tab);
    case "send.log":
      return sendLog(tab, message.chat, message.log);
  }
}

type Request = ConnectionRequest | BatchRequest | TallyRequest | PanelRequest;

function answer(message: Request, sender: chrome.runtime.MessageSender) {
  if (message.type === "connection") return connection();
  if ("tabId" in message) return sender.tab ? Promise.resolve(null) : forPanel(message);
  const tab = sender.tab;
  if (message.type === "tally") return tab?.id === undefined ? Promise.resolve(null) : tallied(tab.id, message);
  return tab?.id === undefined ? Promise.resolve(null) : handle(message, { ...tab, id: tab.id });
}

// Tori opens a server's URL through the system, so a second click or a run
// restart would stack tabs; fold Tori's own tab into the one already there.
async function collapse(tab: chrome.tabs.Tab) {
  if (tab.openerTabId !== undefined || tab.id === undefined) return;
  const port = localPort(addressOf(tab));
  if (port === null) return;
  const keeper = keeperOf(tab, await chrome.tabs.query({}), port);
  if (keeper?.id === undefined) return;
  if ((await call("browser.opened", { url: addressOf(tab) })) !== true) return;
  await chrome.tabs.update(keeper.id, { active: true });
  await chrome.windows.update(keeper.windowId, { focused: true });
  await chrome.tabs.remove(tab.id);
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void refreshAll();
  syncPageLog();
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});
chrome.runtime.onStartup.addListener(() => {
  void refreshAll();
  syncPageLog();
});
chrome.storage.onChanged.addListener((change, area) => {
  if (area !== "local" || !(LOG_KEY in change)) return;
  syncPageLog();
  void paintAll();
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === "complete") void enqueue(tab);
  // Swallowed: the tab can close or navigate away before the script lands.
  if (change.status === "complete" && localPort(tab.url) !== null) void restore(tab).catch(() => {});
  else if (change.status === "complete") void dropBatch(tabId);
});
// Swallowed: an older Tori has no browser.opened, and the tab just stays.
chrome.tabs.onCreated.addListener((tab) => void collapse(tab).catch(() => {}));
chrome.tabs.onRemoved.addListener(forgetTab);
// Swallowed: browser pages refuse every script, and the toolbar title already says why.
chrome.action.onClicked.addListener((tab) => void openTray(tab).catch(() => {}));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "pick" && tab) void togglePicker(tab);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  void answer(message, sender).then(reply, () => reply(null));
  return true;
});

chrome.runtime.onConnect.addListener((panel) => {
  if (panel.name !== PANEL_PORT) return;
  let page: chrome.runtime.Port | null = null;
  panel.onMessage.addListener((message: PanelIn) => {
    if (message.type !== "watch") {
      page?.postMessage(message);
      return;
    }
    page?.disconnect();
    const opened = chrome.tabs.connect(message.tabId, { name: LOG_PORT });
    page = opened;
    opened.onMessage.addListener((out: PanelOut) => panel.postMessage(out));
    opened.onDisconnect.addListener(() => {
      // Read, or Chrome logs a page with no relay as an unchecked error.
      void chrome.runtime.lastError;
      if (page !== opened) return;
      page = null;
      panel.postMessage({ type: "missing" } satisfies PanelOut);
    });
  });
  panel.onDisconnect.addListener(() => page?.disconnect());
});
