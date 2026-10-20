import type { LogChannel, LogMessage, TallyRequest } from "./pick";

const CHANNEL: LogChannel = "tori:page-log";

function tell(message: LogMessage) {
  document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify(message) }));
}

document.addEventListener(CHANNEL, (e) => {
  if (!(e instanceof CustomEvent) || typeof e.detail !== "string") return;
  let message: LogMessage;
  try {
    message = JSON.parse(e.detail) as LogMessage;
  } catch {
    return;
  }
  if (message.type !== "tally") return;
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
