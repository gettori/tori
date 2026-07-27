// The blast-radius guard for a whole-tree revert (checkpoint_revert_tree).
//
// A tree revert rewrites every file in the repo, so any agent mid-turn in that
// folder can have its work silently clobbered, or can clobber the revert a
// second later. The guard is deliberately conservative and lives here rather
// than in Rust: "Executing" is composed in the frontend from PTY activity plus
// the transcript tail (LeftSidebar's `sessionDot`), and the backend cannot see
// it.
//
// Two tiers, because Sway's certainty differs between them:
//   - a session *known* to be mid-turn blocks hard, with no override. That is
//     a live agent tab reporting Executing, and now also a chat session, whose
//     own event stream says exactly when a turn is running;
//   - a detached session (found by the pgrep tier, no tab of ours) can never
//     report Executing, so its activity is unknowable. "Cannot verify" blocks
//     by default, but the user can override it explicitly, since a detached
//     session is often just an idle shell someone left open.
import { isUnderPath } from "./pathScope";
import type { SessionStatus } from "./sessionStatus";

export type RevertCandidate = {
  sessionId: string;
  sessionName: string;
  folderPath: string;
  status: SessionStatus;
  /** Does Sway host this session in a tab of its own (a PTY agent tab or a chat
   *  tab)? Detached sessions, found only by the pgrep probe, are false and
   *  their status tops out at "running". */
  hasLiveTab: boolean;
};

export type RevertBlocker = {
  sessionId: string;
  sessionName: string;
  /** "executing": verified mid-turn, hard block. "detached": possibly active,
   *  cannot verify, overridable. */
  kind: "executing" | "detached";
};

export type RevertVerdict =
  | { allow: true; blockers: readonly RevertBlocker[] }
  | {
      allow: false;
      overridable: boolean;
      blockers: readonly RevertBlocker[];
      reason: string;
    };

function nameList(blockers: readonly RevertBlocker[]): string {
  const names = blockers.map((b) => b.sessionName);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Every session inside the revert's blast radius, i.e. rooted at or under the
 *  repo folder the revert rewrites. The prefix rule matches the worktree-removal
 *  guard's (`countRunningUnder`), so an agent in a project subfolder counts. */
export function revertBlockers(candidates: readonly RevertCandidate[], folderPath: string): RevertBlocker[] {
  const blockers: RevertBlocker[] = [];
  for (const c of candidates) {
    if (!isUnderPath(c.folderPath, folderPath)) continue;
    // Executing blocks on the status alone, not on `hasLiveTab && executing`.
    // That earlier pairing leaned on an invariant chat retired: it was true
    // while only a PTY agent tab could compose "executing", and a candidate
    // that reported it without a live tab fell through both branches and
    // blocked nothing at all. A session we can see is mid-turn is a hard block
    // however we came to see it.
    if (c.status === "executing") {
      blockers.push({
        sessionId: c.sessionId,
        sessionName: c.sessionName,
        kind: "executing",
      });
    } else if (!c.hasLiveTab && c.status === "running") {
      blockers.push({
        sessionId: c.sessionId,
        sessionName: c.sessionName,
        kind: "detached",
      });
    }
  }
  return blockers;
}

/** Decide whether a tree revert may proceed. `allowDetached` is the user having
 *  explicitly chosen "revert anyway" on the detached-session warning; it never
 *  unblocks a verified Executing session. */
export function revertGuard(
  candidates: readonly RevertCandidate[],
  opts: { folderPath: string; allowDetached?: boolean },
): RevertVerdict {
  const blockers = revertBlockers(candidates, opts.folderPath);
  const executing = blockers.filter((b) => b.kind === "executing");
  if (executing.length) {
    return {
      allow: false,
      overridable: false,
      blockers,
      reason: `${nameList(executing)} ${executing.length === 1 ? "is" : "are"} running a turn right now. Wait for it to finish before reverting.`,
    };
  }
  const detached = blockers.filter((b) => b.kind === "detached");
  if (detached.length && !opts.allowDetached) {
    return {
      allow: false,
      overridable: true,
      blockers,
      reason: `${nameList(detached)} ${detached.length === 1 ? "is" : "are"} running outside Sway, so we can't tell whether ${detached.length === 1 ? "it's" : "they're"} mid-turn. Reverting could overwrite work in progress.`,
    };
  }
  return { allow: true, blockers };
}
