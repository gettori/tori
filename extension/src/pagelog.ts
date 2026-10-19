import { fillDirectives, Logbook, show } from "./logbook";
import type { LogChannel, LogKind, LogMessage } from "./pick";

const CHANNEL: LogChannel = "tori:page-log";
const UPDATE_MS = 250;

const book = new Logbook();
let listening = false;
let queued = false;

function post(message: LogMessage) {
  document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify(message) }));
}

function update() {
  if (!listening || queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    post({ type: "entries", entries: book.unsent() });
  }, UPDATE_MS);
}

function add(kind: LogKind, text: string) {
  if (book.add(kind, text)) update();
}

// The page's own code must never see this script fail.
function safely(work: () => void) {
  try {
    work();
  } catch {
    return;
  }
}

function where(url: string): string {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin ? u.pathname + u.search : u.href;
  } catch {
    return url;
  }
}

for (const [name, kind] of [
  ["error", "error"],
  ["warn", "warn"],
] as const) {
  const native = console[name];
  console[name] = (...args: unknown[]) => {
    safely(() => add(kind, fillDirectives(args)));
    native.apply(console, args);
  };
}

addEventListener("error", (e) => {
  safely(() => {
    if (!(e instanceof ErrorEvent)) return;
    const at = e.filename ? ` (${where(e.filename)}:${e.lineno}:${e.colno})` : "";
    add("uncaught", e.error instanceof Error ? show(e.error) : `${e.message}${at}`);
  });
});

addEventListener("unhandledrejection", (e) => safely(() => add("rejection", show(e.reason))));

const nativeFetch = window.fetch;
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const what = `${method} ${where(request ? request.url : String(input))}`;
  const signal = init?.signal ?? request?.signal;
  return nativeFetch(input, init).then(
    (response) => {
      if (response.status >= 400) safely(() => add("request", `${what} -> ${response.status}`));
      return response;
    },
    (error: unknown) => {
      if (!signal?.aborted) safely(() => add("request", `${what} -> failed`));
      throw error;
    },
  );
};

// Attached on the first open, ahead of the handlers a page usually sets after it, and read
// on load, error and timeout, which fire before loadend: a page that reuses the object from
// its loadend handler has reopened it by the time loadend reaches us.
const opened = new WeakMap<XMLHttpRequest, string>();
const sending = new WeakMap<XMLHttpRequest, string>();
function watchRequest(xhr: XMLHttpRequest) {
  const failed = () => safely(() => add("request", `${sending.get(xhr)} -> failed`));
  xhr.addEventListener("load", () => {
    if (xhr.status >= 400) safely(() => add("request", `${sending.get(xhr)} -> ${xhr.status}`));
  });
  xhr.addEventListener("error", failed);
  xhr.addEventListener("timeout", failed);
}

const nativeOpen = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
  safely(() => {
    if (!opened.has(this)) watchRequest(this);
    opened.set(this, `${String(args[0]).toUpperCase()} ${where(String(args[1]))}`);
  });
  nativeOpen.apply(this, args);
} as typeof XMLHttpRequest.prototype.open;

const nativeSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  safely(() => sending.set(this, opened.get(this) ?? ""));
  nativeSend.call(this, body);
};

function lines(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function viteOverlay(): string | null {
  const root = document.querySelector("vite-error-overlay")?.shadowRoot;
  if (!root) return null;
  const read = (selector: string) => lines(root.querySelector(selector)?.textContent);
  return [read(".message"), read(".file")].filter(Boolean).join("\n") || null;
}

function nextOverlay(): string | null {
  const dialog = document.querySelector("nextjs-portal")?.shadowRoot?.querySelector("[data-nextjs-dialog]");
  return dialog instanceof HTMLElement ? lines(dialog.innerText) || null : null;
}

function readOverlays() {
  if (book.overlay(viteOverlay() ?? nextOverlay())) update();
}

// Overlays are children of the body, and Next opens its dialog inside a portal that is always there.
const watcher = new MutationObserver(() => safely(watchOverlays));
const watched = new WeakSet<Node>();
function observe(node: Node, subtree: boolean) {
  if (watched.has(node)) return;
  watched.add(node);
  watcher.observe(node, { childList: true, subtree });
}
function watchOverlays() {
  if (document.body) observe(document.body, false);
  const portal = document.querySelector("nextjs-portal")?.shadowRoot;
  if (portal) observe(portal, true);
  readOverlays();
}
observe(document.documentElement, false);

document.addEventListener(CHANNEL, (e) => {
  safely(() => {
    if (!(e instanceof CustomEvent) || typeof e.detail !== "string") return;
    const message = JSON.parse(e.detail) as LogMessage;
    if (message.type === "mark") book.mark(message.seq);
    if (message.type !== "ask") return;
    listening = true;
    watchOverlays();
    post({ type: "entries", entries: book.unsent() });
  });
});
