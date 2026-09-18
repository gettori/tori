---
summary: git worktree list still shows a folder deleted outside git, prune first then filter by is_dir before trusting it
status: current
updated: 2026-08-28
source: "Feature lifecycle, member management and repair (personal/tori, branch `feature-workspace`, issue #159) - phase 3 - `src-tauri/src/features.rs` `build_member`, `src-tauri/src/worktree.rs` `prune_worktrees`, commit ede61ff - _2026-08-28_"
---

# git keeps listing a worktree you deleted outside it

Do NOT read `git worktree list` as "these folders exist". Why: a worktree folder removed by hand (or by anything that did not run `git worktree prune`) stays in the admin dir and keeps listing, marked `prunable gitdir file points to non-existent location` in the porcelain output, and `list_worktrees_body` (`worktree.rs:44`) does not parse the `prunable` field at all. `build_member` adopted such an entry, flipped the member `Present` at a path that is not there, and `reconcile_member`'s separate `is_dir` check put it straight back to `WorktreeMissing` on the next read, so Recreate looped forever on the exact state it exists for. Prune first, then filter the list on `Path::new(&w.path).is_dir()`: both, because prune skips a locked entry and can fail on a repo git is unhappy with.
