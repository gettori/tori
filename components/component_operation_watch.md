---
summary: one non-recursive watch per git dir on operation marker files, 300 ms trailing settle, emits worktree://operation for one row
status: current
updated: 2026-11-06
source: plan "Survive a rebase, a restart and a delete" (personal/tori, branch `rebase-recovery`); `src-tauri/src/operation_watch.rs`, `src-tauri/src/worktree.rs:633` (`operation`), `src-tauri/src/config.rs:684` (`attach_operations`), `src/utils/worktreeOperation.ts`; commit 8e2d94a0
---

# Operation watch

`src-tauri/src/operation_watch.rs` tells the sidebar when a rebase, merge, cherry-pick or revert starts, moves a step or ends in a worktree, without a config reload.

## Responsibility

**Read.** `worktree::operation(folder)` (`worktree.rs:633`) resolves the git dir through `worktree::git_dir` (`.git` when it is a directory, else the admin dir the `gitdir:` file names, relative paths included) and checks marker files directly: `rebase-merge/{head-name,msgnum,end}`, `rebase-apply/{head-name,next,last}`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`. Only when one exists does it spawn `git diff --name-only --diff-filter=U` for the conflicted count, so a worktree with nothing going on costs no git process. The replayed branch is `replaying`, never `branch`: `list_worktrees_body` keeps reporting `(detached)` mid-rebase, deliberately, see [[gotcha_list_worktrees_body_names_a_detached_head_detached]].

**Attach.** `config.rs` `attach_operations` (`config.rs:684`) stamps `operation` on own-folder units (worktree units, and only the current unit of a plain repo, whose other units share the folder) after `cached_probe`, outside the HEAD-stamp cache, because resolving a conflict moves no HEAD.

**Watch.** `operation_watch_start(folders)` replaces the previous watcher with one `NonRecursive` watch per canonicalized git dir (events arrive with `/private/var` for `/var`). Events are matched by exact file name against `MARKERS` (`operation_watch.rs:17`) and by parent dir; `index` is never one of them, see [[gotcha_watching_a_git_dir_must_skip_index]]. HEAD stands in for `rebase-merge/msgnum`, which sits below the non-recursive watch: a rebase rewrites HEAD on every pick. `settle` (`operation_watch.rs:52`) is a trailing per-folder debounce of 300 ms, so the last write of a burst (the rebase finishing) is the one read. It emits `worktree://operation` `{ folder, operation }`, never `config://changed`, which would be a full reload per pick.

**Show.** The sidebar calls `operation_watch_start` from `loadConfig` and patches the one row with `applyOperation` (`src/utils/worktreeOperation.ts`); a start or an end also triggers one `loadConfig`, because the unit's own `branch` moves then. `displayBranch` gives the row and the breadcrumb the replayed branch; `operationChip` gives "Rebasing 3/7", "Conflict 3/7" plus a file count, "Merging", "Cherry-picking" or "Reverting". The branch mark goes static amber (`--attention-fg`), not a pulse, which already means an agent mid-turn.

## Related

- [[gotcha_a_worktrees_git_is_a_file_so_merge_head_must_come_from_rev_parse_git_path]]: why the git dir is resolved, and why `conflict.rs` asks git instead (it costs up to 5 processes per call)
- [[component_rescue_copies]]: records the operation in the copy's trailers
- [[gotcha_the_project_watcher_must_filter_churn_dirs]]: the same filtering lesson for the project tree watcher
- [[lesson_a_restart_mid_rebase_lost_a_users_work]]
