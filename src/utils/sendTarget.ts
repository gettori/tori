// The capability gate every safe-send surface asks before offering a button.
//
// Safe-send needs a *resumable* session to land text in: no session selected,
// or an adapter whose sessions cannot be resumed, and there is nowhere for the
// message to go. Three panels had grown their own copy of the same two checks
// and the same two sentences, which is three places for the wording to drift
// and three places to forget a new rule.
//
// It answers with either the target or the reason, so a caller cannot build a
// target without having passed the gate ([[concept_safe_send]]).
import { findAdapter } from "./agents";
import type { SessionTarget } from "./safeSend";

/** The fields of a sidebar `Selection` this needs. Structural rather than the
 *  `Selection` type itself, so a util does not depend on a panel. */
export type SendCandidate = {
  agent?: string;
  sessionId?: string;
  sessionPath?: string;
  sessionFile?: string;
  sessionCwd?: string;
  sessionTitle?: string;
  folderPath: string;
};

export type SendGate = { target: SessionTarget } | { reason: string };

/** Whether this selection can be sent to, and what to say when it cannot. */
export function sendTargetFor(selection: SendCandidate | null): SendGate {
  if (!selection?.sessionId) return { reason: "Select a session first" };
  if (findAdapter(selection.agent ?? "claude").resume_args.length === 0) {
    return { reason: "This agent's sessions can't be resumed" };
  }
  return {
    target: {
      sessionId: selection.sessionId,
      agent: selection.agent ?? "claude",
      folderPath: selection.folderPath,
      sessionCwd: selection.sessionCwd,
      sessionPath: selection.sessionPath,
      sessionTitle: selection.sessionTitle,
      sessionFile: selection.sessionFile,
    },
  };
}

/** The reason a send is refused, or null when it is not. What a disabled
 *  button's tooltip reads. */
export function sendBlockedReason(selection: SendCandidate | null): string | null {
  const gate = sendTargetFor(selection);
  return "reason" in gate ? gate.reason : null;
}
