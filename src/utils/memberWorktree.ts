// Destroying a Feature member's worktree, in one place.
//
// `remove_worktree`'s own doc comment says the backend relies on the UI to tear
// down the PTYs and editor tabs under the folder first, and every existing call
// site emits `PURGE_UNDER_PATH` before it. Remove repository and the delete
// sweep are two more sites, which is exactly how that contract gets forgotten
// once; this is the single function both go through.

import { invoke } from "@tauri-apps/api/core";
import { PURGE_UNDER_PATH, emitWith, type PurgeUnderPath } from "./events";
import type { Member } from "./features";

/** A member whose worktree exists. `branch` is the Feature's, since a member
 *  never has one of its own. */
export type WorktreeMember = Pick<Member, "repoPath"> & { worktreePath: string };

/** Purge first, then remove. `force` is always passed: the caller's dialog has
 *  already shown the uncommitted/unpushed warning, and refusing here after that
 *  reads as the confirm having done nothing.
 *
 *  The purge is sent before the invoke and is not undone by a rejection: a
 *  removal that fails still ran `git worktree remove --force` far enough to be
 *  worth not writing into, and the tabs come back on the next open. */
export async function removeMemberWorktree(
  member: WorktreeMember,
  opts: { branch?: string | null; deleteBranch?: boolean },
): Promise<void> {
  emitWith<PurgeUnderPath>(PURGE_UNDER_PATH, { path: member.worktreePath });
  if (opts.deleteBranch && opts.branch) {
    await invoke("remove_worktree_and_branch", {
      repoPath: member.repoPath,
      worktreePath: member.worktreePath,
      branch: opts.branch,
      force: true,
    });
    return;
  }
  await invoke("remove_worktree", {
    repoPath: member.repoPath,
    worktreePath: member.worktreePath,
    force: true,
  });
}
