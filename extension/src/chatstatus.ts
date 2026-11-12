import { statusFromDot, rollupStatuses } from "../../src/utils/sessionStatus";
import type { ChatEvent } from "../../src/utils/chatTypes";

export type Phase = "working" | "needs" | "done";

export const LINE_CAP = 160;

// The phone's rules (mobile/src/tree.ts), so the tray and the phone never disagree.
export function phaseOf(row: { dot?: unknown }): Phase {
  const r = rollupStatuses([{ status: statusFromDot(typeof row.dot === "string" ? row.dot : "none") }]);
  if (r.waitingForApproval + r.waitingForAnswer > 0) return "needs";
  return r.executing > 0 ? "working" : "done";
}

function lastReply(events: ChatEvent[]): string | null {
  const main = events.filter(
    (e): e is Extract<ChatEvent, { type: "textDelta" }> => e.type === "textDelta" && e.agentId == null,
  );
  const last = main[main.length - 1];
  if (!last) return null;
  return main
    .filter((e) => e.turnId === last.turnId)
    .map((e) => e.text)
    .join("");
}

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_]\s*){3,}$|^\s*\|?[\s:|-]+\|[\s:|-]*$/;

function plain(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function lastLine(events: ChatEvent[]): string | null {
  const text = lastReply(events);
  if (text == null) return null;
  let inCode = false;
  let found: string | null = null;
  for (const raw of text.split("\n")) {
    if (FENCE.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || RULE.test(raw)) continue;
    const line = plain(raw);
    if (line) found = line;
  }
  if (found == null) return null;
  return found.length > LINE_CAP ? `${found.slice(0, LINE_CAP - 1).trimEnd()}…` : found;
}
