// The sidebar's session dot, extracted from LeftSidebar's closure into a pure
// function so today's behaviour can be pinned by a golden fixture.
//
// Why this needed extracting: Phase 11 adds a *third* status tier for chat
// sessions ahead of the existing branches, and the standing promise is that the
// PTY-agent and external-session paths keep behaving byte-for-byte as they do
// now. A promise like that is only checkable against a recorded baseline, and
// the logic could not be recorded while it lived inside a component closure
// reading four signals. Extracting it changes no behaviour - LeftSidebar calls
// straight through - it only makes the behaviour observable.
//
// Three tiers now, in descending order of certainty:
//
//   * **Chat (exact).** A chat session's own event stream states its status
//     outright - a turn is running or it is not, a tool call is blocked or it
//     is not - so nothing below is consulted for it. This is the branch Phase
//     11 added, and it is deliberately first: composing a guess on top of a
//     measurement could only make it worse.
//   * **PTY agent tab (inferred).** A live tab that is not running is `none`,
//     not idle - the probe is what says the process exists at all. Needs-you
//     requires **both** a quiet PTY and a blocked-looking transcript tail;
//     either alone is a guess.
//   * **Detached (inferred, weakest).** A session with **no live tab** caps at
//     the hollow "running" dot. Working and needs-you both require watching a
//     real PTY, which only a live tab has, so claiming either for a detached
//     session would assert certainty we do not have.
//
// The two inferred tiers are untouched by the chat branch, which is checked
// rather than promised: the golden fixture enumerates them with no chat status
// present and must reproduce byte-for-byte.
import { dotFromStatus, type SessionStatus } from "./sessionStatus";

export type SessionDot = "solid" | "hollow" | "working" | "needsYou" | "none";

/** How Sway came to know a dot: measured from the session's own event stream,
 *  or inferred from a probe plus a transcript tail. Rendered only on the exact
 *  side (see `LeftSidebar`), because marking the inferred side would change how
 *  every pre-chat session renders. */
export type StatusCertainty = "exact" | "inferred";

export type SessionDotInputs = {
  /** The chat tier: what this session's own event stream says it is doing.
   *  Absent for every session not hosted in a chat tab, which is what makes
   *  this branch inert for the two inferred tiers. */
  chatStatus?: SessionStatus;
  /** Whether a live terminal tab is hosting this session right now. */
  hasLiveTab: boolean;
  /** The pgrep liveness probe: is a process for this session alive? */
  running: boolean;
  /** PTY output activity for the hosting tab, absent when there is no tab. */
  ptyActivity?: "active" | "quiet" | string;
  /** The transcript-tail classification, e.g. "blocked-candidate". */
  tailState?: string;
};

export function computeSessionDot(input: SessionDotInputs): SessionDot {
  // Ahead of everything: an exact answer is never improved by a guess.
  if (input.chatStatus !== undefined) return dotFromStatus(input.chatStatus);
  if (!input.hasLiveTab) return input.running ? "hollow" : "none";
  if (!input.running) return "none";
  if (input.ptyActivity === "active") return "working";
  if (input.ptyActivity === "quiet" && input.tailState === "blocked-candidate") return "needsYou";
  return "solid";
}

/** Which tier answered. Derived from the same inputs rather than returned
 *  alongside the dot, so the golden fixture's recorded shape does not move. */
export function dotCertainty(input: SessionDotInputs): StatusCertainty {
  return input.chatStatus !== undefined ? "exact" : "inferred";
}
