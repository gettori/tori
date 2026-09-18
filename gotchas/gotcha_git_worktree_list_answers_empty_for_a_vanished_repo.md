---
summary: list_worktrees_body returns an empty ok on any git failure including a deleted repo, check repo_readable first
status: current
updated: 2026-08-25
source: Features phase 0 (#152), branch `feature-workspace`; `src-tauri/src/worktree.rs:29` (`repo_readable`), `src-tauri/src/features.rs:179` (`reconcile_member`), `:291` (`feature_container`); commit 4f9c5ab
---

# git worktree list answers empty for a vanished repo

Do not read an empty `list_worktrees_body` as "no worktrees": it returns `Ok(vec![])` on any git failure, a deleted repo dir included, and `config.rs` callers rely on that. Ask `worktree::repo_readable` first, or a vanished repo reconciles as "worktree missing" instead of "repo missing" and placement code creates `.tori/worktrees` at the dead path. Why: the empty Ok cannot be changed to an Err without touching every discovery caller.
