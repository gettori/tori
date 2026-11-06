---
summary: deleting a worktree with unsaved work first keeps one commit under refs/tori/rescue for 30 days, restored from the project menu
status: current
updated: 2026-11-06
source: plan "Survive a rebase, a restart and a delete" (personal/tori, branch `rebase-recovery`); `src-tauri/src/rescue.rs`, `src/components/Dialogs/RestoreWorktreeDialog.tsx`; commits 43e7d624, b89355ae
---

# Rescue copies

`src-tauri/src/rescue.rs` keeps a copy of a worktree's work before it is deleted, lists the copies and restores one.

## Responsibility

**Keep.** `keep(folder, deleted_branch)` (`rescue.rs:152`) runs inside `worktree::remove_worktree_deleting`, after setup is killed and the run command stopped and before teardown, so every removal path gets it (sidebar, Topic demote, losing fan out attempts). It acts only when `has_work` (`rescue.rs:38`) says so: an operation in progress, `tree_dirty` (which ignores `.shared` links), or HEAD holding commits no ref holds. That last rule is `held_by_no_ref` (`rescue.rs:52`): `HEAD --not [--exclude=<branch being deleted>] --branches --remotes --tags`, so `refs/tori/*` never counts as a holder and a branch about to go does not either. Only `remove_worktree_and_branch` passes the branch; attempts pass none, so a losing attempt's commits go with its branch and only its uncommitted work is kept.

The copy is one commit: tree from a temp `GIT_INDEX_FILE` seeded with `read-tree HEAD` then `add -A -- . :(exclude,literal)<big>` (`snapshot`, `rescue.rs:91`), parent HEAD, made with `commit-tree --no-gpg-sign` and Tori as author and committer, so a repo with no identity or a signing setup cannot stall a delete. Untracked or modified files over `LARGE_FILE` (50 MB, `rescue.rs:19`) are left out and named. Metadata rides in message trailers (`Tori-Worktree`, `Tori-Branch` = the rebase's replayed branch else the checked-out one, `Tori-Operation` like `rebase 3/7`, `Tori-Skipped`), because the worktree's admin dir, where a sidecar would live, goes with the folder. The ref is `refs/tori/rescue/<unix_ms>-<sha8>`, created with `update-ref <ref> <commit> ""` so it never overwrites. If there was work and the copy cannot be written, the delete stops with "Tori could not keep a copy of this worktree's work, so it was not deleted". A folder git cannot read (an untrusted repo) skips the copy instead of becoming undeletable.

**Tell the dialog.** `worktree_status` returns `keepsCopy` and `keepsCopyWithBranch`, the same decision for each state of the delete-branch checkbox, and `largeFiles`; `WorktreeRemoveDialog` reads those rather than re-deriving the rule.

**List.** `rescue_counts(repos)` is one `for-each-ref` per project, called from the sidebar's `loadConfig`; a non-zero count shows **Restore deleted worktree** in the project menu. `rescue_list(repo)` (`read`, `rescue.rs:255`) adds the trailers, `diff-tree -r --root --name-only` for the changed files, and the commits `held_by_no_ref` finds from the copy's parent, newest first.

**Restore.** `restore(repo, id)` (`rescue.rs:343`): prune, pick the branch (`restored_branch`, `rescue.rs:326`), `topics::topic_container` (the bare container, or `<repo>/.tori/worktrees`), then `worktree::add_worktree_in(.., hooks = true)`, which is creation without `setup::on_created`. The files go in with `read-tree -u --reset <copy>` then `reset -q`, which writes the copy's tree including deletions and leaves it all unstaged, and only then `on_created` runs, so setup sees the restored files. The command adopts the folder, emits `config://changed` and calls `run::start_after_setup`. If the file write fails, the new worktree and a branch it created are removed. The ref is dropped on success.

Branch rule: the original when it no longer exists (made at the kept HEAD), or when it exists at the kept HEAD and no worktree has it; otherwise `<branch>-restored`, `-restored-2`. A detached copy lands on `restored-<sha8>`. A branch that moved on, or that a recreated worktree holds, is never touched.

**Expire.** `sweep` (`rescue.rs:306`) runs on a startup thread over `config::project_dirs()` and drops refs whose id prefix is over 30 days old.

## Not covered

The operation itself (a restored worktree has the commits and files, the user redoes the rest), the staged split, ignored files, and deleting one copy by hand.

## Related

- [[component_worktree_lifecycle]]: the removal path that calls `keep`, and `add_worktree_in`
- [[component_worktree_setup]]: `on_created` and the run command a restore starts
- [[component_operation_watch]]: `worktree::operation`, the operation a copy records
- [[lesson_a_restart_mid_rebase_lost_a_users_work]]: why this exists
