import { fillDirectives, Logbook, show } from "./logbook";
import type { LogChannel, LogKind, LogMessage } from "./pick";
import { reportable, throttle, type Source } from "./reportable";

const CHANNEL: LogChannel = "tori:page-log";
const UPDATE_MS = 250;
const TALLY_MS = 1000;

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

function tally() {
  post({ type: "tally", ...book.tally() });
}
const retally = throttle(TALLY_MS, tally);

function add(kind: LogKind, text: string, source: Source = {}) {
  if (!book.add(kind, text, Date.now(), reportable(kind, source, location.origin))) return;
  update();
  retally();
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
    const stack = e.error instanceof Error ? e.error.stack : undefined;
    add("uncaught", e.error instanceof Error ? show(e.error) : `${e.message}${at}`, { file: e.filename, stack });
  });
});

addEventListener("unhandledrejection", (e) =>
  safely(() => add("rejection", show(e.reason), { stack: e.reason instanceof Error ? e.reason.stack : undefined })),
);

const nativeFetch = window.fetch;
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const url = request ? request.url : String(input);
  const what = `${method} ${where(url)}`;
  const signal = init?.signal ?? request?.signal;
  return nativeFetch(input, init).then(
    (response) => {
      const status = response.status;
      if (status >= 400) safely(() => add("request", `${what} -> ${status}`, { file: url, status }));
      return response;
    },
    (error: unknown) => {
      if (!signal?.aborted) safely(() => add("request", `${what} -> failed`, { file: url, status: "failed" }));
      throw error;
    },
  );
};

// Attached on the first open, ahead of the handlers a page usually sets after it, and read
// on load, error and timeout, which fire before loadend: a page that reuses the object from
// its loadend handler has reopened it by the time loadend reaches us.
type Target = { what: string; url: string };
const opened = new WeakMap<XMLHttpRequest, Target>();
const sending = new WeakMap<XMLHttpRequest, Target>();
function watchRequest(xhr: XMLHttpRequest) {
  const said = (status: number | "failed") => {
    const target = sending.get(xhr);
    add("request", `${target?.what ?? ""} -> ${status}`, { file: target?.url, status });
  };
  const failed = () => safely(() => said("failed"));
  xhr.addEventListener("load", () => {
    if (xhr.status >= 400) safely(() => said(xhr.status));
  });
  xhr.addEventListener("error", failed);
  xhr.addEventListener("timeout", failed);
}

const nativeOpen = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
  safely(() => {
    if (!opened.has(this)) watchRequest(this);
    const url = String(args[1]);
    opened.set(this, { what: `${String(args[0]).toUpperCase()} ${where(url)}`, url });
  });
  nativeOpen.apply(this, args);
} as typeof XMLHttpRequest.prototype.open;

const nativeSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
  safely(() => sending.set(this, opened.get(this) ?? { what: "", url: "" }));
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
  if (!book.overlay(viteOverlay() ?? nextOverlay())) return;
  update();
  retally();
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
    if (message.type === "tally?") tally();
    if (message.type === "mark") {
      book.mark(message.seqs);
      update();
      retally();
    }
    if (message.type !== "ask") return;
    listening = true;
    watchOverlays();
    post({ type: "entries", entries: book.unsent() });
  });
});

// The relay may be listening already or may start after us, so say it now and answer its tally?.
// A page back from the back/forward cache runs nothing again, so say it again then.
tally();
addEventListener("pageshow", (e) => safely(() => e.persisted && tally()));
