---
summary: every git status rewrites .git/index, so a git dir watcher that reacts to it turns Tori's own polling into a loop
status: current
updated: 2026-11-06
source: plan "Survive a rebase, a restart and a delete" (personal/tori, branch `rebase-recovery`); `src-tauri/src/operation_watch.rs:1` and `:17` (`MARKERS`); commit 8e2d94a0
---

# A git dir watcher must not hear `index`

Do NOT react to every event in a git dir; match the files you care about by exact name. Why: `git status` refreshes and rewrites `index` (and `index.lock`), so a watcher that re-reads state on any write fires on Tori's own status polling, whose read writes `index` again. The operation watch accepts only `HEAD`, `rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD` and `REVERT_HEAD`, and `only_the_files_an_operation_writes_are_heard` pins `index`, `index.lock`, `HEAD.lock`, `ORIG_HEAD`, `FETCH_HEAD` and `logs` as ignored.

## Related

- [[component_operation_watch]]
- [[gotcha_the_project_watcher_must_filter_churn_dirs]]
