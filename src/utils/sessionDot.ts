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
// The composition itself is unchanged and deliberately so:
//
//   * A session with **no live tab** caps at the hollow "running" dot. Working
//     and needs-you both require watching a real PTY, which only a live tab
//     has, so claiming either for a detached session would assert certainty we
//     do not have (see the evidence-tiering concept).
//   * A live tab that is not running is `none`, not idle - the probe is what
//     says the process exists at all.
//   * Needs-you requires **both** a quiet PTY and a blocked-looking transcript
//     tail. Either alone is a guess.

export type SessionDot = "solid" | "hollow" | "working" | "needsYou" | "none";

export type SessionDotInputs = {
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
  if (!input.hasLiveTab) return input.running ? "hollow" : "none";
  if (!input.running) return "none";
  if (input.ptyActivity === "active") return "working";
  if (input.ptyActivity === "quiet" && input.tailState === "blocked-candidate") return "needsYou";
  return "solid";
}
