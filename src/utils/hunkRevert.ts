// The blast-radius rule for reverting one hunk of a tool call's edit.
//
// A per-hunk revert is a much smaller write than the whole-tree revert
// `revertGuard` was built for, but the hazard is the same one and it is worth
// asking the same question: if an agent is mid-turn in this folder, the file we
// are about to rewrite is a file it may be writing, and whichever write lands
// second silently wins. So this reuses `revertGuard` outright rather than
// inventing a second, softer opinion about who is busy - two guards that could
// disagree about the same folder is the failure mode, not the cost.
//
// The two tiers keep their meanings: a session we can see mid-turn is a hard
// refusal, and a detached session (alive by pgrep, no tab of ours, status
// unknowable) is a confirm the user can override, exactly as it is for a tree
// revert.
import { revertGuard, type RevertCandidate } from "./revertGuard";

export type RevertPermission =
  /** Nothing is running here. Go ahead. */
  | { kind: "allow" }
  /** Something might be, but we cannot tell. Ask, then proceed if they say so. */
  | { kind: "confirm"; reason: string }
  /** Something verifiably is. Say why and write nothing. */
  | { kind: "refuse"; reason: string };

export function hunkRevertPermission(candidates: readonly RevertCandidate[], folderPath: string): RevertPermission {
  // `allowDetached` stays false: the point here is to *surface* the detached
  // tier as a question rather than to skip it.
  const verdict = revertGuard(candidates, { folderPath });
  if (verdict.allow) return { kind: "allow" };
  return verdict.overridable ? { kind: "confirm", reason: verdict.reason } : { kind: "refuse", reason: verdict.reason };
}
