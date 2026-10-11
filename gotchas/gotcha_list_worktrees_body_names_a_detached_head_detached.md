---
summary: list_worktrees_body reports a detached worktree's branch as the string (detached), not empty, so an emptiness check lets it through
status: current
updated: 2026-10-11
source: Move an existing worktree into a Topic (gettori/tickets#76, branch `phase-1-block-2`), `src-tauri/src/worktree.rs:85`, `src-tauri/src/topics.rs` (`moved_worktree`), commit 1b73f0ea
---

# A detached worktree's branch is `(detached)`, not empty

Do NOT test `Worktree.branch.is_empty()` to mean "not on a branch". Why: `list_worktrees_body` parses git's porcelain `detached` line into the literal string `(detached)` (`worktree.rs:85`), so a detached worktree has a non-empty branch, and a guard written as an emptiness check waves it through as if it were on a branch named `(detached)`. Check both, the way `worktree_cleanup.rs:76`, `attempts.rs:394` and `topics.rs` `moved_worktree` do; `config.rs:281` writes the same marker for a unit. The move gate's first version checked only `is_empty()`, and its refusal test failed with the detached worktree accepted.

## Related

- [[adr_feature_workspace]] - the moved-in member rule the gate guards
- [[component_feature_store]] - `moved_worktree`, where the check lives
