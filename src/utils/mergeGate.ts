// What GitHub's mergeability verdict means for the two buttons that act on it
// (plan phase 13).
//
// **Read, never decided.** `mergeableState` is the server's answer and it
// accounts for branch protection, required reviewers and required checks that
// Tori cannot see. A local "looks fine to me" would render an enabled button the
// server then refuses, which is strictly worse than no button: the user finds
// out it will not merge only after asking it to.
//
// So the whole of this module is a translation, one sentence per state, and the
// only judgement in it is which states leave the merge button live. That
// judgement follows GitHub's own: `unstable` is *mergeable* (the failing checks
// are not required ones), which is why it warns rather than blocks, and why the
// warning has to say so instead of quietly looking like a green light.

import type { MergeableState } from "./forgeTypes";

/// The four shapes the merge controls take.
///
/// Seven states and four sets of controls, because the panel has one row of
/// buttons and most of the states want the same one. `blocked` is the only
/// condition where merging is genuinely impossible from here, which is why it
/// is the only one that disables the button: everywhere else the label changes
/// what it promises rather than greying out.
export type MergeCondition = "ready" | "behind" | "dirty" | "blocked";

/** What one verdict means here: whether the two buttons act, and what to say. */
export type MergeGate = {
  condition: MergeCondition;
  /** Whether the merge button is inert. A flag rather than a reason, because
   *  `summary` is already the sentence on screen: a second copy of it here would
   *  be a string nothing renders and everything has to keep in step with. */
  block: boolean;
  /** Whether the base can be merged into this head from here. `behind` and
   *  `dirty`: the states where the base has moved on. Every other one either
   *  does not need it or is not about the base at all. */
  canUpdate: boolean;
  /** The state in one sentence, shown whatever the buttons do. */
  summary: string;
};

/// One entry per state, as a total record rather than a `switch` with a default:
/// a state added to `MergeableState` fails to compile here instead of falling
/// through to whatever the default said, which for a merge gate would mean a
/// live button on a verdict nobody has read.
const GATE: Record<MergeableState, MergeGate> = {
  clean: { condition: "ready", block: false, canUpdate: false, summary: "Ready to merge." },
  unstable: {
    // GitHub allows this merge: the checks that are failing are not required
    // ones. Blocking it here would be Tori overruling the server in the
    // direction that looks safe and is simply wrong.
    condition: "ready",
    block: false,
    canUpdate: false,
    summary: "Some checks are failing, but none that this repo requires.",
  },
  blocked: {
    // Deliberately vague, because the specifics live in a branch-protection rule
    // this app cannot read. Guessing at "needs one approval" would be a sentence
    // Tori invented; the server's own wording arrives if the merge is attempted,
    // and that is where it gets shown.
    condition: "blocked",
    block: true,
    canUpdate: false,
    summary: "A rule on the base branch is holding this merge.",
  },
  behind: {
    condition: "behind",
    block: true,
    canUpdate: true,
    summary: "The base branch has moved on since this one was pushed.",
  },
  dirty: {
    // Offered an update even though this is the state where it can fail. Tori
    // does not resolve conflicts, so the alternatives here are the server's own
    // refusal, which names what is fighting, or a panel with nothing to press.
    condition: "dirty",
    block: true,
    canUpdate: true,
    summary: "This branch conflicts with its base. Resolve it locally and push.",
  },
  draft: {
    // `blocked` is the control shape, not the reason: the sentence above still
    // names the one thing that would change it.
    condition: "blocked",
    block: true,
    canUpdate: false,
    summary: "A draft cannot be merged. Mark it ready for review first.",
  },
  unknown: {
    // Both "GitHub is still computing it" and any state string added later. Ask
    // again is the honest reading; a green light is not.
    condition: "blocked",
    block: true,
    canUpdate: false,
    summary: "GitHub has not said yet whether this can merge.",
  },
};

export function mergeGate(state: MergeableState): MergeGate {
  return GATE[state] ?? GATE.unknown;
}
