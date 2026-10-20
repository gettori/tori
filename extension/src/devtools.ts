import type { Detail, DevToolsNetwork, NetRequest } from "./panel/rows";

// The panel's page loads only when first shown, so this page, which loads with DevTools,
// collects the failed requests before then.
const KEEP = 200;

type Har = chrome.devtools.network.Request;
export type PanelWindow = Window & { attach?: (network: DevToolsNetwork) => void };

let origin = "";
let next = 0;
const list: NetRequest[] = [];
const hars = new Map<number, Har>();
const listeners = new Set<() => void>();

const changed = () => {
  for (const listener of listeners) listener();
};

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

chrome.devtools.inspectedWindow.eval<string>("location.href", (...[href]) => {
  origin = originOf(href ?? "");
});

chrome.devtools.network.onNavigated.addListener((url) => {
  origin = originOf(url);
  list.length = 0;
  hars.clear();
  changed();
});

chrome.devtools.network.onRequestFinished.addListener((har) => {
  let url: URL;
  try {
    url = new URL(har.request.url);
  } catch {
    return;
  }
  if (url.origin !== origin) return;
  const status = har.response.status;
  const error = (har.response as { _error?: string })._error ?? "";
  if (status === 0 ? /ABORTED/.test(error) : status < 500) return;
  const id = ++next;
  const finishedAt = Date.parse(har.startedDateTime) + har.time;
  list.push({ id, finishedAt, what: `${har.request.method} ${url.pathname}${url.search}`, status: status || "failed" });
  hars.set(id, har);
  if (list.length > KEEP) hars.delete(list.shift()!.id);
  changed();
});

const network: DevToolsNetwork = {
  list: () => [...list],
  detail: (id) =>
    new Promise<Detail | null>((resolve) => {
      const har = hars.get(id);
      if (!har) {
        resolve(null);
        return;
      }
      har.getContent((body, encoding) => {
        const response = encoding === "base64" ? "(binary)" : body || null;
        resolve({ url: har.request.url, request: har.request.postData?.text ?? null, response });
      });
    }),
  listen: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

chrome.devtools.panels.create("Tori", "icons/32.png", "panel.html", (panel) => {
  panel.onShown.addListener((win) => (win as PanelWindow).attach?.(network));
});
