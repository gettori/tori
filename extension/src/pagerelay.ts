import { LOG_PORT } from "./pick";
import type { LogChannel, LogMessage, PanelIn, PanelOut, TallyRequest } from "./pick";

const CHANNEL: LogChannel = "tori:page-log";

function tell(message: LogMessage) {
  document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify(message) }));
}

function read(e: Event): LogMessage | null {
  if (!(e instanceof CustomEvent) || typeof e.detail !== "string") return null;
  try {
    return JSON.parse(e.detail) as LogMessage;
  } catch {
    return null;
  }
}

document.addEventListener(CHANNEL, (e) => {
  const message = read(e);
  if (message?.type !== "tally") return;
  const request: TallyRequest = { type: "tally", count: message.count, overflow: message.overflow };
  // Throws, or rejects, once the extension is reloaded under a page that still runs the old relay;
  // the count then waits for the page's next load.
  try {
    void chrome.runtime.sendMessage(request).catch(() => {});
  } catch {
    return;
  }
});

tell({ type: "tally?" });

function serveLogPort(port: chrome.runtime.Port) {
  if (port.name !== LOG_PORT) return;
  const forward = (e: Event) => {
    const message = read(e);
    if (message?.type === "entries" || message?.type === "tally") port.postMessage(message satisfies PanelOut);
  };
  document.addEventListener(CHANNEL, forward);
  port.onDisconnect.addListener(() => document.removeEventListener(CHANNEL, forward));
  port.onMessage.addListener((message: PanelIn) => {
    if (message.type === "mark") tell({ type: "mark", seqs: message.seqs, seq: Math.max(0, ...message.seqs) });
  });
  tell({ type: "ask" });
}

chrome.runtime.onConnect.addListener(serveLogPort);
