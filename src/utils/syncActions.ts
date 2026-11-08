// What the titlebar chip's menu offers for a branch, decided without a DOM.
//
// Only the actions that are safe in one click: nothing here rewrites published
// history or needs a picker. Force push, rebase onto the base and the
// interactive rebase stay in the Changes panel, which is the last row of every
// menu this returns.

import type { BranchSync } from "./gitActions";
import type { FinishedPr } from "./branchSync";
import type { ConflictOp } from "./conflict";
import { OP_WORD } from "./conflict";

export type SyncActionId =
  | "continue"
  | "skip"
  | "abort"
  | "reset"
  | "syncRebase"
  | "pull"
  | "pullRebase"
  | "push"
  | "mergeBase"
  | "fetch";

export type SyncAction = {
  id: SyncActionId;
  label: string;
  /** The sentence under the label: what this will do, in its own numbers. */
  note: string;
  /** Shown but refused, with the note saying why. */
  refusing?: boolean;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The facts a menu is decided from. */
export type SyncActionFacts = {
  sync: BranchSync | null | undefined;
  finished?: FinishedPr | null;
  /** The upstream's name, `origin/main` style, when there is one. */
  upstream?: string | null;
  /** A merge, rebase, cherry-pick or revert that stopped part way. */
  op: ConflictOp;
  /** Files still marked conflicted, which Continue waits for. */
  conflicted: number;
};

/**
 * The menu's actions, most pressing first: the first one is what the chip is
 * asking you to do. Fetch closes every list but the in-progress one, so a menu
 * is never empty of a way to check again.
 *
 * A stopped operation hides everything else. Pull, push and merge all refuse
 * mid-rebase, and offering them would only move the refusal from here to git.
 */
export function syncActions(facts: SyncActionFacts): SyncAction[] {
  const { sync, finished, op } = facts;
  if (op !== "none") return stoppedActions(op, facts.conflicted);

  const out: SyncAction[] = [];
  const fetch: SyncAction = { id: "fetch", label: "Fetch", note: "Check the remote for new commits" };
  if (!sync || sync.detached) return [fetch];

  const { ahead, behind, has_upstream, gone, rewritten, superseded } = sync.upstream;
  const up = facts.upstream || "the upstream";

  if (superseded) {
    out.push({
      id: "reset",
      label: "Reset to Upstream",
      note: `${up} was force-pushed. Move this branch onto its ${plural(behind, "commit")}`,
    });
  } else if (ahead > 0 && behind > 0) {
    // Rewritten history wants a force push, which is the Changes panel's: a
    // pull here would replay the commits you rewrote back on top.
    if (!rewritten) {
      out.push(
        {
          id: "syncRebase",
          label: "Pull (Rebase) and Push",
          note: `Replay your ${plural(ahead, "commit")} on ${up}, then push`,
        },
        {
          id: "pullRebase",
          label: "Pull (Rebase)",
          note: `Replay your ${plural(ahead, "commit")} on top of ${up}`,
        },
        { id: "pull", label: "Pull", note: `Merge ${up} into this branch, adds a merge commit` },
      );
    }
  } else if (behind > 0) {
    out.push({ id: "pull", label: "Pull", note: `Fast-forward to ${up}, ${plural(behind, "commit")}` });
  } else if (finished?.state === "merged") {
    // Its work is in the base, so a push would only put a finished branch back.
  } else if (ahead > 0) {
    out.push({ id: "push", label: "Push", note: `${plural(ahead, "commit")} to ${up}` });
  } else if (!has_upstream && !gone) {
    const unpublished = sync.base?.ahead ?? 0;
    out.push({
      id: "push",
      label: "Publish",
      note:
        unpublished > 0
          ? `Push ${plural(unpublished, "commit")} and create the remote branch`
          : "Create the remote branch",
    });
  }

  // Only where no conflict is predicted: a merge that is known to stop belongs
  // where the conflicted files can be resolved, and the chip already says so.
  const base = sync.base;
  if (base && base.behind > 0 && !base.conflicts?.length && finished?.state !== "merged") {
    out.push({
      id: "mergeBase",
      label: `Merge ${base.name}`,
      note: `Bring in ${base.name}'s ${plural(base.behind, "commit")}, adds a merge commit`,
    });
  }

  out.push(fetch);
  return out;
}

function stoppedActions(op: Exclude<ConflictOp, "none">, conflicted: number): SyncAction[] {
  const word = OP_WORD[op].toLowerCase();
  const out: SyncAction[] = [
    conflicted > 0
      ? {
          id: "continue",
          label: "Continue",
          note: `Resolve ${plural(conflicted, "conflicted file")} in Changes first`,
          refusing: true,
        }
      : { id: "continue", label: "Continue", note: `Carry on with the ${word}` },
  ];
  if (op === "rebase" || op === "cherrypick") {
    out.push({ id: "skip", label: "Skip", note: "Leave out the commit it stopped on" });
  }
  out.push({ id: "abort", label: "Abort", note: `Go back to before the ${word}` });
  return out;
}
