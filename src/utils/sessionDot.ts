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
//
// **A fourth input sits outside the tiers.** `forgeAttention` is a fact about
// the *branch* (a failing check, a changes-requested verdict), not about the
// session, so it is applied to whatever the tiers decided rather than competing
// with them. It has its own golden fixture (`sessionDotCi.golden.json`) for the
// same reason the first one exists, and deliberately not the same file: the
// original is a frozen record of pre-chat behaviour, and letting it absorb new
// rows means one `-u` run rewrites the baseline it was created to protect.
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
  /** Whether the branch-unit this session owns has failing checks or a
   *  changes-requested verdict on its pull request. A fact about the *branch*,
   *  not about the session, which is why it is applied after the tiers rather
   *  than inside them. Absent for every session before the forge answered,
   *  which is what leaves the recorded baseline untouched. */
  forgeAttention?: boolean;
};

function tierDot(input: SessionDotInputs): SessionDot {
  // Ahead of everything: an exact answer is never improved by a guess.
  if (input.chatStatus !== undefined) return dotFromStatus(input.chatStatus);
  if (!input.hasLiveTab) return input.running ? "hollow" : "none";
  if (!input.running) return "none";
  if (input.ptyActivity === "active") return "working";
  if (input.ptyActivity === "quiet" && input.tailState === "blocked-candidate") return "needsYou";
  return "solid";
}

export function computeSessionDot(input: SessionDotInputs): SessionDot {
  const dot = tierDot(input);
  // A failing check raises a session that is **sitting still**, and only that.
  //
  //   * `solid` (a live agent, quiet) and `hollow` (a detached session) become
  //     `needsYou`: the branch is broken and nothing is moving on it.
  //   * `working` is left alone. An agent mid-turn may well be fixing it, and a
  //     needs-you raised while it works cannot re-arm when it stops, so the one
  //     edge that matters would be spent on the moment it mattered least.
  //   * `needsYou` is already there, and `none` means nothing is running for
  //     this to be about - a dead tab must not start ringing because CI went red
  //     on the branch it used to be on.
  //
  // Applied uniformly to the tier result rather than branching per tier, so the
  // chat tier gets the same rule for free: a mid-turn chat is `working` and
  // untouched, an idle one is `solid` and raised.
  if (input.forgeAttention && (dot === "solid" || dot === "hollow")) return "needsYou";
  return dot;
}

/** Which tier answered. Derived from the same inputs rather than returned
 *  alongside the dot, so the golden fixture's recorded shape does not move. */
export function dotCertainty(input: SessionDotInputs): StatusCertainty {
  return input.chatStatus !== undefined ? "exact" : "inferred";
}
