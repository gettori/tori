import TOKENS from "../tokens.css?raw";
import type {
  BatchRequest,
  Chat,
  LogChannel,
  LogEntry,
  LogKind,
  LogMessage,
  Pick,
  PickerRequest,
  Sent,
  Setup,
  Shortcut,
  Shot,
  TrayState,
} from "../pick";
import { capture, hasLine, insideSensitive } from "./capture";

// Injected again on every pick request; the first copy in this world answers.
const loaded = globalThis as { toriPicker?: boolean };

type Mode = "ready" | "pick" | "idle";

const CSS_TEXT = `${TOKENS}
:host { width: 100vw; height: 100vh; margin: 0; padding: 0; border: 0; background: transparent; overflow: visible; color-scheme: light dark; }
@keyframes tori-pulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
@keyframes tori-spin { to { transform: rotate(360deg) } }
svg { flex: none; display: block; }

.hover, .tag, .mark-line, .mark { position: fixed; pointer-events: none; }
.voice { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.mark-line, .mark { z-index: 1; }
.hover, .tag { z-index: 2; }
.hover { box-shadow: var(--tori-ring-pick); background: var(--tori-pick-fill); }
.hover.held { background: transparent; }
.tag { display: flex; gap: var(--tori-sp-3); align-items: center; padding: 3px 7px; border-radius: var(--tori-r-1); background: var(--tori-bg); border: 1px solid var(--tori-bd-strong); box-shadow: var(--tori-shadow-1); font: 500 var(--tori-fs-1)/1.3 var(--tori-mono); color: var(--tori-fg); white-space: nowrap; }
.tag .size { color: var(--tori-fg-3); }
.mark-line { outline: 1px dashed var(--tori-pick); }
.mark { width: 18px; height: 18px; border-radius: 9px; background: var(--tori-acc); color: var(--tori-acc-fg); font: 600 var(--tori-fs-1)/18px var(--tori-mono); text-align: center; }

button { appearance: none; border: none; margin: 0; cursor: pointer; border-radius: var(--tori-r-2); font: 500 var(--tori-fs-2)/1 var(--tori-font); }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible { outline: 2px solid var(--tori-focus); outline-offset: 2px; }
.primary { height: 30px; padding: 0 var(--tori-sp-4); background: var(--tori-acc); color: var(--tori-acc-fg); font-weight: 600; }
.primary:hover:not(:disabled) { background: var(--tori-acc-hover); }
.secondary { height: 28px; padding: 0 10px; background: var(--tori-raised); color: var(--tori-fg); border: 1px solid var(--tori-bd-strong); }
.secondary:hover:not(:disabled) { background: var(--tori-hover); }
.ghost { height: 28px; padding: 0 10px; background: transparent; color: var(--tori-fg-2); }
.ghost:hover:not(:disabled) { background: var(--tori-hover); color: var(--tori-fg); }
.icon { width: 22px; height: 22px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--tori-r-1); background: transparent; color: var(--tori-fg-3); }
.icon:hover:not(:disabled) { background: var(--tori-hover); color: var(--tori-fg); }
.ghost:focus-visible, .icon:focus-visible { outline-offset: 0; }

.tray, .box, .chip { position: fixed; pointer-events: auto; background: var(--tori-bg); color: var(--tori-fg); border: 1px solid var(--tori-bd-strong); font-family: var(--tori-font); font-size: var(--tori-fs-3); line-height: var(--tori-lh); text-align: left; }
.tray { z-index: 3; right: var(--tori-sp-5); bottom: var(--tori-sp-5); width: var(--tori-tray-w); max-height: var(--tori-tray-max-h); display: flex; flex-direction: column; border-radius: var(--tori-r-3); box-shadow: var(--tori-shadow-2); overflow: hidden; }
.head { flex: none; display: flex; align-items: center; gap: var(--tori-sp-3); padding: var(--tori-sp-3) var(--tori-sp-4); border-bottom: 1px solid var(--tori-bd); }
.head .title { font-weight: 600; font-size: var(--tori-fs-2); }
.head .branch { flex: 1; min-width: 0; font-family: var(--tori-mono); font-size: var(--tori-fs-1); color: var(--tori-fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--tori-r-1); background: var(--tori-raised); color: var(--tori-fg-2); font: 600 var(--tori-fs-1)/18px var(--tori-mono); text-align: center; }
.body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.list { list-style: none; margin: 0; padding: var(--tori-sp-2) 0; flex: 1 0 auto; }
.list li { display: grid; grid-template-columns: 18px minmax(0, 1fr) 22px; gap: var(--tori-sp-3); align-items: start; padding: var(--tori-sp-2) var(--tori-sp-2) var(--tori-sp-2) var(--tori-sp-4); }
.num { flex: none; width: 18px; height: 18px; margin-top: 1px; display: flex; align-items: center; justify-content: center; border-radius: var(--tori-r-1); background: var(--tori-acc-soft); color: var(--tori-acc-tx); font: 600 var(--tori-fs-1)/1 var(--tori-mono); }
.what { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.text { overflow-wrap: anywhere; }
.target { font-family: var(--tori-mono); font-size: var(--tori-fs-1); color: var(--tori-fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.note { display: flex; gap: 5px; align-items: center; font-size: var(--tori-fs-1); color: var(--tori-warn-tx); }
.status { flex: none; display: flex; align-items: center; gap: var(--tori-sp-2); padding: var(--tori-sp-2) var(--tori-sp-4); border-top: 1px solid var(--tori-bd); font-size: var(--tori-fs-2); color: var(--tori-fg-2); }
.status .info { display: flex; color: var(--tori-acc-tx); }
.status .warn { display: flex; color: var(--tori-warn-tx); }
.status .grow { flex: 1; min-width: 0; }
.status .ghost { height: 24px; margin: -4px -8px -4px 0; padding: 0 8px; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 4px; background: var(--tori-fg-3); }
.dot.live { background: var(--tori-acc); animation: tori-pulse 1.6s ease-in-out infinite; }
.spin { animation: tori-spin .8s linear infinite; }
.hint { padding: var(--tori-sp-4); display: flex; gap: var(--tori-sp-3); align-items: center; color: var(--tori-fg-2); }
.send { flex: none; display: flex; flex-direction: column; gap: var(--tori-sp-3); padding: var(--tori-sp-3) var(--tori-sp-4) 0; border-top: 1px solid var(--tori-bd); }
.act { flex: none; display: flex; flex-direction: column; gap: var(--tori-sp-3); padding: var(--tori-sp-3) var(--tori-sp-4) var(--tori-sp-4); border-top: 1px solid var(--tori-bd); }
.act.joined, .act.bare { border-top: none; }
.none { display: flex; gap: var(--tori-sp-2); align-items: center; font-size: var(--tori-fs-2); color: var(--tori-fg-2); padding: 2px 0; }
.choose { display: flex; flex-direction: column; gap: var(--tori-sp-2); }
.choose-head { display: flex; align-items: center; justify-content: space-between; gap: var(--tori-sp-3); min-height: 22px; }
.choose-head span { font: 600 var(--tori-fs-1)/1 var(--tori-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--tori-fg-3); }
.choose-head.end { justify-content: flex-end; }
.new-chat { height: 22px; padding: 0 6px 0 4px; display: flex; align-items: center; gap: var(--tori-sp-1); border-radius: var(--tori-r-1); background: transparent; color: var(--tori-acc-tx); }
.new-chat:hover:not(:disabled) { background: var(--tori-acc-soft); }
.new-chat:focus-visible { outline-offset: 0; }
.none .grow { flex: 1; min-width: 0; }
.chooser { display: flex; flex-direction: column; border: 1px solid var(--tori-bd-strong); border-radius: var(--tori-r-2); background: var(--tori-bg-sunk); overflow: hidden; }
.chooser button { border-radius: 0; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: var(--tori-sp-3); align-items: center; padding: 6px var(--tori-sp-3); text-align: left; color: var(--tori-fg); background: transparent; font: 400 var(--tori-fs-2)/1.35 var(--tori-font); }
.chooser button + button { border-top: 1px solid var(--tori-bd); }
.chooser button:hover { background: var(--tori-hover); }
.chooser button[aria-checked="true"] { background: var(--tori-acc-soft); }
.chooser button:focus-visible { outline-offset: -2px; }
.radio { width: 12px; height: 12px; border-radius: 6px; border: 1px solid var(--tori-bd-strong); background: var(--tori-bg); }
[aria-checked="true"] .radio { border: 4px solid var(--tori-acc); }
.chat-title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[aria-checked="true"] .chat-title { font-weight: 500; }
.agent { font-family: var(--tori-mono); font-size: var(--tori-fs-1); color: var(--tori-fg-3); }
.go { width: 100%; min-width: 0; font-size: var(--tori-fs-3); display: flex; align-items: center; justify-content: center; gap: var(--tori-sp-2); }
.go span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.go[aria-busy="true"]:disabled { opacity: .75; cursor: progress; }
.alert { display: flex; gap: var(--tori-sp-2); align-items: flex-start; padding: 6px var(--tori-sp-3); border-radius: var(--tori-r-2); background: var(--tori-danger-soft); color: var(--tori-danger); font-size: var(--tori-fs-2); line-height: 1.4; }
.alert svg { margin-top: 1px; }
.alert span { overflow-wrap: anywhere; }
.foot { display: flex; justify-content: space-between; align-items: center; gap: var(--tori-sp-2); }
.foot .ghost { margin-left: -10px; }
.done { padding: var(--tori-sp-4); display: flex; flex-direction: column; gap: var(--tori-sp-4); }
.done-row { display: flex; gap: var(--tori-sp-3); align-items: flex-start; }
.ok { display: flex; padding-top: 1px; color: var(--tori-ok); }
.done-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.done-title { font-weight: 600; overflow-wrap: anywhere; }
.sub { font-size: var(--tori-fs-2); color: var(--tori-fg-2); }
.actions { display: flex; justify-content: flex-end; gap: var(--tori-sp-2); }
.actions .primary { height: 28px; font-size: var(--tori-fs-2); }

.box { z-index: 4; width: var(--tori-comment-w); padding: var(--tori-sp-3); display: flex; flex-direction: column; gap: var(--tori-sp-3); border-radius: var(--tori-r-3); box-shadow: var(--tori-shadow-2); }
.caret { position: absolute; width: 10px; height: 10px; background: var(--tori-bg); transform: rotate(45deg); }
.caret.up { top: -6px; border-left: 1px solid var(--tori-bd-strong); border-top: 1px solid var(--tori-bd-strong); }
.caret.down { bottom: -6px; border-right: 1px solid var(--tori-bd-strong); border-bottom: 1px solid var(--tori-bd-strong); }
.box-head { display: flex; align-items: center; gap: var(--tori-sp-3); min-width: 0; }
.box-head .num { margin-top: 0; }
.box-head .target { min-width: 0; color: var(--tori-fg-2); line-height: 1; }
textarea { display: block; width: 100%; margin: 0; resize: none; overflow-y: hidden; padding: 6px 8px; border-radius: var(--tori-r-2); border: 1px solid var(--tori-bd-strong); background: var(--tori-bg-sunk); color: var(--tori-fg); font: 400 var(--tori-fs-3)/var(--tori-lh) var(--tori-font); outline: none; }
textarea::placeholder { color: var(--tori-fg-3); }
textarea:focus { border-color: var(--tori-acc); box-shadow: 0 0 0 2px var(--tori-acc-soft); }
.box-foot { display: flex; align-items: center; gap: var(--tori-sp-2); }
.keys { flex: 1; min-width: 0; font-size: var(--tori-fs-1); line-height: 1.3; color: var(--tori-fg-3); }
.box .ghost { height: 26px; padding: 0 8px; }
.box .primary { height: 26px; padding: 0 12px; font-size: var(--tori-fs-2); }

.chip { z-index: 4; height: 26px; padding: 0 10px 0 8px; display: flex; align-items: center; gap: 6px; border-radius: var(--tori-r-pill); box-shadow: var(--tori-shadow-1); font: 600 var(--tori-fs-2)/1 var(--tori-font); white-space: nowrap; }
.chip:hover { background: var(--tori-hover); }
.chip .glyph { display: flex; color: var(--tori-acc); }

.head .icon { margin: -2px 0; }
.ready { padding: var(--tori-sp-4); }
.pick-now { width: 100%; height: 32px; padding: 0 var(--tori-sp-2) 0 var(--tori-sp-4); display: flex; align-items: center; gap: var(--tori-sp-3); font-size: var(--tori-fs-3); }
.pick-now span { flex: 1; text-align: left; white-space: nowrap; }
kbd { flex: none; font: 500 var(--tori-fs-1)/1 var(--tori-mono); padding: 4px 6px; border-radius: var(--tori-r-1); background: var(--tori-kbd-on-acc); }
`;

const SWALLOWED = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];
const DRAG_PX = 4;
// What isSensitive covers, blanked for the moment of a screenshot.
const MASK = `input[type="password"], input[autocomplete="off"], textarea[autocomplete="off"],
input[data-sensitive], textarea[data-sensitive] { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }`;
const KEEP_PICKING = "Press the shortcut or click Tori to keep picking";
const PICKING = "Click an element or select text. Esc stops.";
const DRAFTING = "Opening a new chat in Tori\u2026";
const DRAFTED = "New chat open in Tori";
const DRAFT_NEXT = "Pick a model and send it there.";
const TEXTAREA_ROWS = 6;
const CHANNEL: LogChannel = "tori:page-log";
const LOG_KINDS: [kinds: LogKind[], one: string, many: string][] = [
  [["error", "uncaught", "rejection"], "error", "errors"],
  [["overlay"], "build error", "build errors"],
  [["warn"], "warning", "warnings"],
  [["request"], "failed request", "failed requests"],
];
const EDGE = 8;
const CARET_X = 28;

type Shape = [tag: string, attrs: Record<string, string>];

const CHAT_PATH = "M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z";
const RING: Shape = ["circle", { cx: "8", cy: "8", r: "6.25" }];
const ICONS = {
  check: [16, 1.5, [RING, ["path", { d: "M5.5 8.2l1.7 1.7 3.3-3.6" }]]],
  info: [14, 1.5, [RING, ["path", { d: "M8 7.3v3.9M8 4.9v.1" }]]],
  alert: [14, 1.5, [RING, ["path", { d: "M8 4.8v3.8M8 11v.1" }]]],
  remove: [12, 1.6, [["path", { d: "M4 4l8 8M12 4l-8 8" }]]],
  noImage: [
    12,
    1.5,
    [
      ["rect", { x: "2", y: "3", width: "12", height: "10", rx: "1.5" }],
      ["path", { d: "M2 2l12 12" }],
    ],
  ],
  chat: [14, 1.4, [["path", { d: CHAT_PATH }]]],
  close: [14, 1.6, [["path", { d: "M4 4l8 8M12 4l-8 8" }]]],
  plus: [12, 1.6, [["path", { d: "M8 3.5v9M3.5 8h9" }]]],
  options: [
    14,
    1.5,
    [
      ["path", { d: "M2.5 4.5h3M8.5 4.5h5M2.5 11.5h6M11.5 11.5h2" }],
      ["circle", { cx: "7", cy: "4.5", r: "1.5" }],
      ["circle", { cx: "10", cy: "11.5", r: "1.5" }],
    ],
  ],
  chatPlus: [
    14,
    1.5,
    [
      ["path", { d: CHAT_PATH }],
      ["path", { d: "M8 5.5v4M6 7.5h4" }],
    ],
  ],
  spinner: [
    12,
    2,
    [
      ["circle", { cx: "8", cy: "8", r: "6", "stroke-opacity": ".3" }],
      ["path", { d: "M14 8a6 6 0 0 0-6-6" }],
    ],
  ],
} satisfies Record<string, [number, number, Shape[]]>;

// Built node by node: a page's Trusted Types policy would refuse innerHTML.
function icon(name: keyof typeof ICONS, size?: number): SVGSVGElement {
  const [natural, stroke, shapes] = ICONS[name];
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const px = String(size ?? natural);
  for (const [k, v] of Object.entries({ width: px, height: px, viewBox: "0 0 16 16", fill: "none" }))
    svg.setAttribute(k, v);
  for (const [k, v] of Object.entries({ stroke: "currentColor", "stroke-width": String(stroke) }))
    svg.setAttribute(k, v);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  if (name === "spinner") svg.classList.add("spin");
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function button(className: string, text: string, onclick: () => void, key?: string): HTMLButtonElement {
  const b = el("button", { type: "button", className, textContent: text, onclick });
  if (key) b.dataset.key = key;
  return b;
}

function ask<T>(message: BatchRequest): Promise<T> {
  return chrome.runtime.sendMessage(message);
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const plain = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(n, high));

const comments = (n: number) => `${n} comment${n === 1 ? "" : "s"}`;

const carried = (count: number, withLog: boolean) =>
  !withLog ? comments(count) : count ? `${comments(count)} and the page log` : "the page log";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function summary(log: LogEntry[]): string {
  return LOG_KINDS.map(([kinds, one, many]) => {
    const n = log.filter((e) => kinds.includes(e.kind)).reduce((sum, e) => sum + e.count, 0);
    return n ? `${n} ${n === 1 ? one : many}` : "";
  })
    .filter(Boolean)
    .join(", ");
}

const tell = (message: LogMessage) =>
  document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify(message) }));

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const quoted = (text: string) => `\u201c${oneLine(text)}\u201d`;

function nameOf(target: Element): string {
  const tag = target.tagName.toLowerCase();
  if (target.id) return `${tag}#${target.id}`;
  const first = target.classList[0];
  return first ? `${tag}.${first}` : tag;
}

const targetOf = (pick: Pick) =>
  pick.kind === "selection" ? quoted(pick.text) : (pick.selector.split(" > ").pop() ?? "");

function radiusOf(target: Element): number {
  const r = getComputedStyle(target).borderTopLeftRadius;
  return r.endsWith("px") ? parseFloat(r) : 0;
}

// One selector the page no longer accepts must not take every other marker down with it.
function find(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function box(node: HTMLElement, r: DOMRect, grow: number, radius = 0) {
  Object.assign(node.style, {
    left: `${r.left - grow}px`,
    top: `${r.top - grow}px`,
    width: `${r.width + grow * 2}px`,
    height: `${r.height + grow * 2}px`,
    borderRadius: `${radius}px`,
  });
}

function start() {
  const host = document.createElement("tori-picker");
  host.popover = "manual";
  const root = host.attachShadow({ mode: "closed" });
  const marks = el("div");
  const hoverBox = el("div", { className: "hover" });
  const tag = el("div", { className: "tag" });
  const tray = el("section", { className: "tray" });
  tray.setAttribute("role", "region");
  tray.setAttribute("aria-label", "Tori comments");
  // Each render rebuilds the tray, and a live region announces only once it exists, so one outlives them all.
  const voice = el("div", { className: "voice" });
  voice.setAttribute("aria-live", "polite");
  root.append(el("style", { textContent: CSS_TEXT }), marks, voice);
  let commentBox: HTMLElement | null = null;
  let placeOpen: (() => void) | null = null;
  let outlined: Element | null = null;
  let chip: HTMLElement | null = null;
  let mode: Mode | null = null;
  let restored = false;
  let picks: Pick[] = [];
  let targets: (Element | null)[] = [];
  let branch = "";
  let shortcut: Shortcut | null = null;
  let status: string | null | undefined;
  let screenshots = true;
  let pageLog = true;
  let log: LogEntry[] = [];
  let asking = false;
  let replied = false;
  let chats: Chat[] | null = null;
  let chosen = "";
  let sent: { chat: Chat | null; count: number; log: boolean } | null = null;
  let sending = false;
  let drafting = false;
  let error = "";
  let flash = "";
  let setup: Setup | null | undefined;
  let down: { x: number; y: number } | null = null;

  const say = (text = "") => {
    if (voice.textContent !== text) voice.textContent = text;
  };

  const ours = (e: Event) => e.composedPath().includes(host);

  const onWorktree = () => status === null;

  const logged = () => pageLog && onWorktree() && log.length > 0;

  // Picking with nothing picked yet keeps its own hint.
  const canSend = () => picks.length > 0 || (mode !== "pick" && logged());

  // The page log answers inside dispatchEvent, so no answer means it is not running on this load.
  const pullLog = () => {
    if (!pageLog) {
      log = [];
      return;
    }
    asking = true;
    replied = false;
    tell({ type: "ask" });
    asking = false;
    if (!replied) log = [];
  };

  document.addEventListener(CHANNEL, (e) => {
    if (!(e instanceof CustomEvent) || typeof e.detail !== "string") return;
    let message: LogMessage;
    try {
      message = JSON.parse(e.detail) as LogMessage;
    } catch {
      return;
    }
    if (message.type !== "entries") return;
    replied = true;
    log = message.entries;
    if (!asking && !sending && tray.isConnected) renderTray();
  });

  // In the top layer, above any z-index the page uses.
  const mount = () => {
    if (!host.isConnected) document.documentElement.append(host);
    if (!host.matches(":popover-open")) host.showPopover();
  };

  const loadChats = () => {
    chats = [];
    void ask<Chat[] | null>({ type: "chats" }).then((found) => {
      chats = found ?? [];
      if (!chats.some((c) => c.id === chosen)) chosen = chats[0]?.id ?? "";
      renderTray();
    });
  };

  const header = (): HTMLElement => {
    const head = el(
      "div",
      { className: "head" },
      el("span", { className: "title", textContent: "Tori" }),
      el("span", { className: "branch", textContent: branch, title: branch }),
    );
    if (picks.length) {
      const count = el("span", { className: "count", textContent: String(picks.length) });
      count.setAttribute("aria-label", comments(picks.length));
      head.append(count);
    }
    if (mode === "ready") {
      const options = button("icon", "", () => void ask({ type: "options" }), "options");
      options.append(icon("options"));
      options.setAttribute("aria-label", "Options");
      const close = button("icon", "", leave, "close");
      close.append(icon("close"));
      close.setAttribute("aria-label", "Close");
      head.append(options, close);
    }
    return head;
  };

  const alert = (text: string): HTMLElement => {
    const line = el("div", { className: "alert" }, icon("alert"), el("span", { textContent: text }));
    line.setAttribute("role", "alert");
    return line;
  };

  const row = (pick: Pick, i: number): HTMLElement => {
    const what = el(
      "span",
      { className: "what" },
      el("span", { className: "text", textContent: pick.comment || "(no comment)" }),
      el("span", { className: "target", textContent: targetOf(pick) }),
    );
    if (screenshots && !pick.images.length) {
      what.append(el("span", { className: "note" }, icon("noImage"), "No screenshot. It is sent as text only."));
    }
    const remove = button("icon", "", () => void removePick(i), `remove-${i}`);
    remove.append(icon("remove"));
    remove.setAttribute("aria-label", `Remove comment ${i + 1}`);
    remove.disabled = sending;
    const num = el("span", { className: "num", textContent: String(i + 1) });
    num.setAttribute("aria-hidden", "true");
    return el("li", {}, num, what, remove);
  };

  const statusLine = (): HTMLElement => {
    const line = el("div", { className: "status" });
    if (sending) line.append(icon("spinner"), drafting ? DRAFTING : `Sending ${carried(picks.length, logged())}\u2026`);
    else if (flash) line.append(flash);
    else if (mode === "pick") line.append(el("span", { className: "dot live" }), "Picking. Esc stops.");
    else if (restored) line.append(el("span", { className: "info" }, icon("info", 14)), KEEP_PICKING);
    else {
      const more = shortcut ? `${shortcut.label} picks more.` : "Click Tori to pick more.";
      line.append(el("span", { className: "dot" }), `Not picking. ${more}`);
    }
    return line;
  };

  const logLine = (): HTMLElement =>
    el(
      "div",
      { className: "status" },
      el("span", { className: "warn" }, icon("alert", 14)),
      `Page log: ${summary(log)}`,
    );

  const chainWithoutLine = () => picks.some((p) => p.where?.chain.length && !hasLine(p.where.source));

  const loadSetup = () => {
    setup = null;
    void ask<Setup | null>({ type: "setup" }).then((found) => {
      setup = found;
      if (found) renderTray();
    });
  };

  const copySetup = async (app: Setup) => {
    try {
      await navigator.clipboard.writeText(`${app.install}\n\n// ${app.config}\n${app.snippet}\n`);
      flash = "Copied the plugin setup";
      error = "";
    } catch {
      error = "Could not copy";
    }
    renderTray();
  };

  const setupLine = (): HTMLElement[] => {
    if (!setup || setup.plugin || setup.own_lines || !chainWithoutLine()) return [];
    const app = setup;
    const copy = button("ghost", "Copy", () => void copySetup(app), "setup-copy");
    return [
      el(
        "div",
        { className: "status" },
        el("span", { className: "info" }, icon("info", 14)),
        el("span", { className: "grow", textContent: `File and line: add code-inspector-plugin to ${app.config}` }),
        copy,
      ),
    ];
  };

  const chooser = (list: Chat[]): HTMLElement => {
    const group = el("div", { className: "chooser" });
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", "tori-send-to");
    const choose = (id: string) => {
      chosen = id;
      renderTray(`chat-${id}`);
    };
    for (const chat of list) {
      const on = chat.id === chosen;
      const radio = button("", "", () => choose(chat.id), `chat-${chat.id}`);
      radio.setAttribute("role", "radio");
      radio.setAttribute("aria-checked", String(on));
      radio.tabIndex = on ? 0 : -1;
      radio.append(
        el("span", { className: "radio" }),
        el("span", { className: "chat-title", textContent: chat.title, title: chat.title }),
        el("span", { className: "agent", textContent: chat.agent }),
      );
      radio.onkeydown = (e) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const at = list.findIndex((c) => c.id === chosen);
        choose(list[(at + step + list.length) % list.length].id);
      };
      group.append(radio);
    }
    const label = el(
      "div",
      { className: "choose-head" },
      el("span", { id: "tori-send-to", textContent: "Send to" }),
      newChat(),
    );
    return el("div", { className: "choose" }, label, group);
  };

  const newChat = (): HTMLElement => {
    const draft = button("new-chat", "", () => void sendTo(null), "new-chat");
    draft.append(icon("plus"), "New chat in Tori");
    draft.disabled = sending;
    return draft;
  };

  const choice = (): HTMLElement[] => {
    if (!canSend() || !chats) return [];
    if (!chats.length) {
      const none = el("span", { className: "grow", textContent: "No live chat in this worktree" });
      return [el("div", { className: "send" }, el("div", { className: "none" }, icon("chat"), none, newChat()))];
    }
    if (chats.length === 1)
      return [el("div", { className: "send" }, el("div", { className: "choose-head end" }, newChat()))];
    return [el("div", { className: "send" }, chooser(chats))];
  };

  const actions = (joined: boolean): HTMLElement => {
    const area = el("div", { className: joined ? "act joined" : canSend() ? "act" : "act bare" });
    if (error) area.append(alert(error));
    if (canSend() && chats?.length) {
      const only = chats.length === 1 ? chats[0] : null;
      const go = button("primary go", "", () => void sendTo(chats!.find((c) => c.id === chosen)!), "send");
      go.disabled = sending;
      if (sending && !drafting) {
        go.setAttribute("aria-busy", "true");
        go.append(icon("spinner", 14), "Sending\u2026");
      } else go.append(el("span", { textContent: only ? `Send to ${only.title}` : "Send" }));
      area.append(go);
    }
    const cancel = button("ghost", "Cancel", cancelBatch, "cancel");
    cancel.disabled = sending;
    const foot = el("div", { className: "foot" }, cancel);
    if (canSend()) {
      const copy = button("secondary", "Copy as Markdown", () => void copyBatch(), "copy");
      copy.disabled = sending;
      foot.append(copy);
    }
    area.append(foot);
    return area;
  };

  const sentView = ({ chat, count, log: withLog }: NonNullable<typeof sent>): HTMLElement => {
    const what = capital(carried(count, withLog));
    const done = el(
      "div",
      { className: "done-row" },
      el("span", { className: "ok" }, icon("check")),
      el(
        "span",
        { className: "done-text" },
        el("span", { className: "done-title", textContent: chat ? `Sent to ${chat.title}` : DRAFTED }),
        el("span", { className: "sub", textContent: chat ? what : `${what}. ${DRAFT_NEXT}` }),
      ),
    );
    const actions = el("div", { className: "actions" }, button("secondary", "Close", leave, "close"));
    if (chat) actions.append(button("primary", "Show in Tori", () => void reveal(chat), "show"));
    return el("div", { className: "done" }, done, ...(error ? [alert(error)] : []), actions);
  };

  const renderTray = (focus?: string) => {
    const waiting = mode === "ready" && status === undefined;
    if ((!picks.length && (mode === null || (!logged() && mode !== "pick" && mode !== "ready")) && !sent) || waiting) {
      tray.remove();
      return;
    }
    if (canSend() && chats === null) loadChats();
    const keep = focus ?? (root.activeElement as HTMLElement | null)?.dataset?.key;
    if (sent && !picks.length) tray.replaceChildren(header(), sentView(sent));
    else if (mode === "ready" && status) {
      tray.replaceChildren(header(), el("div", { className: "hint" }, el("span", { className: "dot" }), status));
    } else if (mode === "ready") {
      const go = button("primary pick-now", "", enter, "pick");
      go.append(el("span", { textContent: "Pick and comment" }));
      if (shortcut) {
        go.append(el("kbd", { textContent: shortcut.label }));
        go.setAttribute("aria-keyshortcuts", shortcut.aria);
      }
      const ready = el("div", { className: "ready" }, go);
      if (!logged()) tray.replaceChildren(header(), ready);
      else {
        const choosing = choice();
        const copied = flash ? [el("div", { className: "status" }, flash)] : [];
        const body = el("div", { className: "body" }, ready, ...copied, logLine(), ...choosing);
        tray.replaceChildren(header(), body, actions(choosing.length > 0));
      }
    } else if (!picks.length) {
      const hint = el("div", { className: "hint" }, el("span", { className: "dot live" }), PICKING);
      tray.replaceChildren(header(), hint, actions(false));
    } else {
      const list = el("ol", { className: "list" }, ...picks.map(row));
      list.setAttribute("aria-label", "Comments");
      // One scroller under the header and Send outside it, so a short window still reaches Send.
      const choosing = choice();
      if (setup === undefined && chainWithoutLine()) loadSetup();
      const body = el(
        "div",
        { className: "body" },
        list,
        statusLine(),
        ...setupLine(),
        ...(logged() ? [logLine()] : []),
        ...choosing,
      );
      const scrolled = tray.querySelector(".body")?.scrollTop ?? 0;
      tray.replaceChildren(header(), body, actions(choosing.length > 0));
      body.scrollTop = scrolled;
    }
    if (!tray.isConnected) root.append(tray);
    mount();
    say(
      sent && !picks.length
        ? `${sent.chat ? `Sent to ${sent.chat.title}` : DRAFTED}, ${carried(sent.count, sent.log)}`
        : (tray.querySelector(".status, .hint")?.textContent ?? ""),
    );
    if (keep) tray.querySelector<HTMLElement>(`[data-key="${CSS.escape(keep)}"]`)?.focus();
  };

  const resolve = (i: number): Element | null => {
    const known = targets[i];
    if (known?.isConnected) return known;
    targets[i] = find(picks[i].selector);
    return targets[i];
  };

  const renderMarks = () => {
    const drawn: HTMLElement[] = [];
    picks.forEach((_, i) => {
      const target = resolve(i);
      const r = target?.getBoundingClientRect();
      if (!target || !r || (!r.width && !r.height)) return;
      const line = el("div", { className: "mark-line" });
      box(line, r, 4, radiusOf(target) + 2);
      const mark = el("div", { className: "mark", textContent: String(i + 1) });
      Object.assign(mark.style, { left: `${r.left - 12}px`, top: `${r.top - 12}px` });
      drawn.push(line, mark);
    });
    marks.replaceChildren(...drawn);
  };

  let queued = false;
  const follow = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderMarks();
      if (outlined) showOutline(outlined);
      placeOpen?.();
    });
  };
  const changes = new MutationObserver(follow);
  let following = false;
  const watch = (on: boolean) => {
    if (on === following) return;
    following = on;
    const method = on ? addEventListener : removeEventListener;
    method("scroll", follow, true);
    method("resize", follow);
    if (on)
      changes.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    else changes.disconnect();
  };

  const refresh = (focus?: string) => {
    renderTray(focus);
    renderMarks();
    watch(host.isConnected);
  };

  const sendTo = async (chat: Chat | null) => {
    sending = true;
    drafting = !chat;
    error = "";
    pullLog();
    const said = logged() ? log : [];
    renderTray();
    const outcome = await ask<Sent | null>({ type: "send", chat, log: said });
    sending = false;
    drafting = false;
    if (outcome && "title" in outcome) {
      sent = { chat: chat && { ...chat, title: outcome.title }, count: picks.length, log: outcome.logged };
      if (outcome.logged) {
        const seqs = said.map((e) => e.seq);
        // `seq` is for a page still running the page log from before an update, which reads only that.
        tell({ type: "mark", seqs, seq: Math.max(...seqs) });
        log = log.filter((e) => !seqs.includes(e.seq));
      }
      picks = [];
      targets = [];
      flash = "";
      refresh(chat ? "show" : "close");
      return;
    }
    error = outcome?.error ?? "Could not send";
    renderTray("send");
  };

  const reveal = async (chat: Chat) => {
    const r = await ask<{ error?: string } | null>({ type: "reveal", id: chat.id });
    error = r?.error ?? "";
    renderTray();
  };

  const copyBatch = async () => {
    try {
      pullLog();
      await navigator.clipboard.writeText(await ask<string>({ type: "markdown", log: logged() ? log : [] }));
      flash = "Copied as Markdown";
      error = "";
    } catch {
      error = "Could not copy";
    }
    renderTray();
  };

  const cancelBatch = () => {
    picks = [];
    void ask({ type: "batch.clear" });
    leave();
  };

  let removing = false;
  const removePick = async (i: number) => {
    if (removing) return;
    removing = true;
    picks = await ask<Pick[]>({ type: "batch.remove", index: i }).finally(() => (removing = false));
    targets.splice(i, 1);
    flash = "";
    error = "";
    if (!picks.length && mode !== "pick" && !logged()) leave();
    else {
      if (!picks.length && mode !== "pick") rest();
      refresh(picks.length ? `remove-${Math.min(i, picks.length - 1)}` : "cancel");
    }
  };

  const hideOutline = () => {
    outlined = null;
    hoverBox.remove();
    tag.remove();
  };

  const showOutline = (target: Element) => {
    outlined = target;
    const r = target.getBoundingClientRect();
    box(hoverBox, r, 2, radiusOf(target) + 2);
    hoverBox.classList.toggle("held", !!commentBox);
    root.append(hoverBox);
    if (commentBox) tag.remove();
    else {
      tag.replaceChildren(
        nameOf(target),
        el("span", { className: "size", textContent: `${Math.round(r.width)} \u00d7 ${Math.round(r.height)}` }),
      );
      root.append(tag);
      const above = r.top - 2 - 8 - tag.offsetHeight;
      tag.style.top = `${above >= 4 ? above : r.bottom + 2 + 8}px`;
      tag.style.left = `${clamp(r.left - 2, 4, innerWidth - tag.offsetWidth - 4)}px`;
    }
    mount();
  };

  const closeBox = () => {
    commentBox?.remove();
    commentBox = null;
    placeOpen = null;
  };

  const closeChip = () => {
    chip?.remove();
    chip = null;
    document.removeEventListener("selectionchange", collapsed);
  };

  const collapsed = () => {
    if (getSelection()?.isCollapsed) closeChip();
  };

  const screenshot = async (target: Element, range?: Range): Promise<Shot> => {
    const { scrollX, scrollY } = window;
    host.style.display = "none";
    const mask = el("style", { textContent: MASK });
    document.documentElement.append(mask);
    if (!range) target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    await frame();
    await frame();
    const rect = (range ?? target).getBoundingClientRect();
    try {
      return (await ask<Shot | null>({ type: "shot", rect: plain(rect), viewport: innerWidth })) ?? { images: [] };
    } finally {
      scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
      mask.remove();
      host.style.display = "";
    }
  };

  const placeBox = (node: HTMLElement, caret: HTMLElement, r: DOMRect) => {
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const left = clamp(r.left - 2, EDGE, innerWidth - width - EDGE);
    const below = r.bottom + 12;
    const roomBelow = innerHeight - EDGE - below;
    const roomAbove = r.top - 12 - EDGE;
    const under = roomBelow >= height || roomBelow >= roomAbove;
    const top = clamp(under ? below : r.top - 12 - height, EDGE, innerHeight - height - EDGE);
    Object.assign(node.style, { left: `${left}px`, top: `${top}px` });
    caret.className = under ? "caret up" : "caret down";
    caret.style.left = `${clamp(r.left - 2 + CARET_X - left, 12, width - 22)}px`;
  };

  const comment = (target: Element, selection?: { text: string; range: Range }) => {
    closeBox();
    closeChip();
    const before = document.activeElement;
    const n = picks.length + 1;
    const what = selection ? quoted(selection.text) : nameOf(target);
    const input = el("textarea", { rows: 3, placeholder: "What should change?" });
    input.setAttribute("aria-label", "Comment");
    const add = button("primary", "Add", () => void submit());
    add.disabled = true;
    const caret = el("span", { className: "caret" });
    caret.setAttribute("aria-hidden", "true");
    const head = el(
      "div",
      { className: "box-head" },
      el("span", { className: "num", textContent: String(n) }),
      el("span", { className: "target", textContent: what }),
    );
    const foot = el(
      "div",
      { className: "box-foot" },
      el("span", { className: "keys" }, "Enter adds", el("br"), "Shift+Enter new line"),
      button("ghost", "Cancel", () => close()),
      add,
    );
    const node = el("div", { className: "box" }, caret, head, input, foot);
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", `Comment on ${what}`);
    commentBox = node;
    root.append(node);
    if (selection) hideOutline();
    else showOutline(target);
    const line = parseFloat(getComputedStyle(input).lineHeight);
    const grow = () => {
      input.style.height = "auto";
      const max = line * TEXTAREA_ROWS + 14;
      input.style.height = `${Math.min(input.scrollHeight + 2, max)}px`;
      input.style.overflowY = input.scrollHeight + 2 > max ? "auto" : "hidden";
    };
    grow();
    placeOpen = () => placeBox(node, caret, (selection?.range ?? target).getBoundingClientRect());
    placeOpen();
    const close = () => {
      closeBox();
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
      else input.blur();
      if (outlined) showOutline(outlined);
    };
    const submit = async () => {
      const said = input.value.trim();
      if (!said) return;
      const facts = capture(
        target,
        said,
        root,
        selection && { text: selection.text, rect: selection.range.getBoundingClientRect() },
      );
      close();
      hideOutline();
      screenshots = (await ask<boolean | null>({ type: "screenshots" })) !== false;
      const shot: Shot = screenshots ? await screenshot(target, selection?.range) : { images: [] };
      picks = await ask<Pick[]>({ type: "batch.add", pick: { ...facts, images: shot.images } });
      targets = [...targets.slice(0, picks.length - 1), target];
      sent = null;
      chats = null;
      error = "";
      flash = shot.why ? `No screenshot: ${shot.why}` : "";
      refresh();
    };
    input.oninput = () => {
      add.disabled = !input.value.trim();
      grow();
      placeOpen?.();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    };
    input.focus({ preventScroll: true });
  };

  const offerSelection = (selection: Selection) => {
    const range = selection.getRangeAt(0);
    const common = range.commonAncestorContainer;
    const target = common instanceof Element ? common : common.parentElement;
    const text = selection.toString();
    if (!target || !text.trim() || insideSensitive(selection.anchorNode)) return false;
    const rects = range.getClientRects();
    const end = rects[rects.length - 1] ?? range.getBoundingClientRect();
    closeChip();
    const offer = button("chip", "", () => comment(target, { text, range: range.cloneRange() }));
    offer.append(el("span", { className: "glyph" }, icon("chatPlus")), "Pick selection");
    // Pressing it would otherwise collapse the selection it acts on.
    offer.onmousedown = (e) => e.preventDefault();
    chip = offer;
    root.append(offer);
    const below = end.bottom + 6;
    const top = below + offer.offsetHeight <= innerHeight - EDGE ? below : end.top - 6 - offer.offsetHeight;
    offer.style.top = `${top}px`;
    offer.style.left = `${clamp(end.right - offer.offsetWidth / 2, EDGE, innerWidth - offer.offsetWidth - EDGE)}px`;
    document.addEventListener("selectionchange", collapsed);
    return true;
  };

  const swallow = (e: Event) => {
    if (ours(e)) return;
    e.stopImmediatePropagation();
    // Left alone on the way down, so dragging still selects text.
    if (e.type === "pointerdown" || e.type === "mousedown") {
      if (e instanceof MouseEvent) down = { x: e.clientX, y: e.clientY };
      return;
    }
    e.preventDefault();
    if (e.type !== "click" || !(e instanceof MouseEvent)) return;
    const dragged = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX;
    const selection = getSelection();
    if (dragged && selection && !selection.isCollapsed && offerSelection(selection)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target) comment(target);
  };

  const hover = (e: MouseEvent) => {
    if (commentBox || ours(e) || !(e.target instanceof Element)) return;
    showOutline(e.target);
  };

  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (mode === "ready") leave();
    else if (commentBox) commentBox.querySelector<HTMLButtonElement>(".ghost")?.click();
    else stop();
  };

  const listen = (on: boolean) => {
    const method = on ? addEventListener : removeEventListener;
    for (const type of SWALLOWED) method(type, swallow, true);
    method("mousemove", hover as EventListener, true);
    method("keydown", key as EventListener, true);
  };

  const stop = () => {
    if (mode === "pick") listen(false);
    if (!picks.length && !logged()) {
      leave();
      return;
    }
    if (picks.length) mode = "idle";
    else rest();
    flash = "";
    closeBox();
    closeChip();
    hideOutline();
    refresh();
  };

  const leave = () => {
    if (mode === "pick") listen(false);
    removeEventListener("keydown", key as EventListener, true);
    mode = null;
    restored = false;
    flash = "";
    error = "";
    chats = null;
    sent = null;
    closeBox();
    closeChip();
    hideOutline();
    marks.replaceChildren();
    watch(false);
    host.remove();
  };

  const rest = () => {
    mode = "ready";
    addEventListener("keydown", key as EventListener, true);
  };

  const enter = () => {
    if (mode !== "pick") listen(true);
    mode = "pick";
    restored = false;
    flash = "";
    refresh();
  };

  // The toolbar opens the tray first; the shortcut goes straight to picking.
  const open = () => {
    if (mode === "ready") leave();
    else if (mode === "pick") stop();
    else if (mode === "idle") enter();
    else {
      rest();
      refresh();
    }
  };

  chrome.runtime.onMessage.addListener((message: PickerRequest) => {
    if (message.type === "picker.open") open();
    else if (mode === "pick") stop();
    else enter();
  });

  void ask<TrayState | null>({ type: "batch.get" }).then((opened) => {
    if (!opened) return;
    ({ picks, branch, shortcut, status, screenshots, pageLog } = opened);
    pullLog();
    targets = picks.map((p) => find(p.selector));
    if ((mode === null || mode === "ready") && picks.length) {
      mode = "idle";
      restored = true;
    }
    refresh();
  });
}

if (!loaded.toriPicker) {
  loaded.toriPicker = true;
  start();
}
