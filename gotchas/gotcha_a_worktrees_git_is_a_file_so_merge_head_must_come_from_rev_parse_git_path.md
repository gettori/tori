---
summary: a linked worktree's .git is a file, so find MERGE_HEAD via rev-parse git-path, not by joining .git onto the path
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/sway, branch `wave-2`); Phase 11; `src-tauri/src/conflict.rs` (`git_conflict_op`); commit 02f5805"
---

# A worktree's `.git` is a file, so `MERGE_HEAD` must come from `rev-parse --git-path`

Don't locate git's in-progress state by joining `.git` onto the project path. Why: in a linked worktree `.git` is a **file** pointing elsewhere, and `MERGE_HEAD` / `rebase-merge` actually live under `<main>/.git/worktrees/<name>/`, so the naive join makes every conflict in every worktree read as "nothing in progress". The side labels then fall back to the merge orientation, which is exactly wrong mid-rebase. Ask git: `rev-parse --git-path MERGE_HEAD`. Pin it with a **linked-worktree** fixture, because a fixture built in a plain repo passes with the naive join.
