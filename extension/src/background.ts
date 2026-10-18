import { SPACE_COLORS, spaceHue } from "../../src/utils/spaceTint";
import {
  CLOSED,
  GROUPS_KEY,
  NOT_RUNNING,
  NOT_SET_UP,
  NOT_WORKTREE,
  label,
  type GroupColor,
  type StateRequest,
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

// The host answers its last frame with CLOSED and exits; a fresh one says why.
async function call(method: string, params: object): Promise<unknown> {
  try {
    return await send(method, params);
  } catch (e) {
    if (!(e instanceof Error) || e.message !== CLOSED) throw e;
    return send(method, params);
  }
}

function send(method: string, params: object): Promise<unknown> {
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    waiting.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result)));
    try {
      open().postMessage({ jsonrpc: "2.0", id, method, params });
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
    await chrome.action.setTitle({ tabId, title: state.title });
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

chrome.runtime.onInstalled.addListener(() => void refreshAll());
chrome.runtime.onStartup.addListener(() => void refreshAll());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.url || change.status === "complete") void enqueue(tab);
});
chrome.runtime.onMessage.addListener((request: StateRequest, _sender, reply) => {
  if (request.type !== "state") return false;
  void chrome.tabs
    .get(request.tabId)
    .then(mark)
    .then(reply, () => reply(null));
  return true;
});
