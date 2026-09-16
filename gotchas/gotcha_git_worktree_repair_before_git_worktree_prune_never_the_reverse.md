---
summary: pruning before repairing a moved repo deletes the admin entry for a worktree that still physically exists
status: current
updated: 2026-08-28
source: "Feature lifecycle, member management and repair (personal/sway, branch `feature-workspace`, issue #159) - phase 3 - `src-tauri/src/features.rs` `relocate_member`, commit ede61ff - _2026-08-28_"
---

# `git worktree repair` before `git worktree prune`, never the reverse

Do NOT prune a repo you are about to repair. Why: after the repo folder moves, git lists its worktree at the **old** path and marks it prunable, so a prune deletes the admin entry for a checkout that is still physically there and still has your work in it. Repair rewrites the entry to the new path instead; measured, not assumed (`git -C moved worktree list --porcelain` before and after). `relocate_member` runs `git worktree repair <new worktree path>` and only then prunes whatever repair could not save, so a member that cannot be repaired lands on `WorktreeMissing` honestly and Recreate can build it. Repair is not "rebuild the worktree"; it is what makes the reconcile that follows honest.
