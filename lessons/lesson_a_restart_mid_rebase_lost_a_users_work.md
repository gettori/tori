---
summary: a slow login shell after a macOS update cached a PATH failure forever, the mid-rebase row read (detached), and the delete lost it
status: current
updated: 2026-11-06
source: plan "Survive a rebase, a restart and a delete" (personal/tori, branch `rebase-recovery`), from a user report with a screenshot; commits f05e68b8, 8e2d94a0, 43e7d624, b89355ae
---

# A restart in the middle of a rebase lost a user's work

## What happened

A user stopped a rebase with a few files still to commit, installed a macOS update and restarted. Back in Tori the worktree row said **(detached)**, and the session's **Reconnect** failed with "could not start claude: No such file or directory (os error 2)". The folder was still in Finder, so they deleted the worktree (keeping the branch) and made a new one from the branch. The rebased commits and the resolved files were gone.

Three separate faults lined up:

1. **PATH.** The first login shell after an OS update can take longer than the 5 s probe. `env.rs` cached the failed probe in a `OnceLock` for the life of the process, and agent spawns read the non-blocking `login_path_if_captured()`, which is also empty while the startup probe is still running. So every spawn used the fallback PATH, `claude` was not on it, and the `ENOENT` read like the folder was missing.
2. **The label.** Mid-rebase HEAD is detached, so git's porcelain says `detached` and the row printed `(detached)`. Nothing said a rebase was waiting.
3. **The delete.** A worktree's rebase state and its replayed commits live in its admin dir (`.git/worktrees/<name>`) and on no branch. `git worktree remove` deletes both, and the old branch still points at the pre-rebase commit, so recreating from it brings back none of it.

## What we learned

- A cached failure is a decision to stay broken. Cache successes; give failures a cooldown and a reason.
- An error message must say which thing was missing. "No such file or directory" was true of the binary and read as the folder; the spawn error now checks the cwd first, then whether the program is on the PATH it handed the child, and names the probe's failure.
- A state git calls detached can be the most important state a worktree is in. The row needs the operation, not just HEAD.
- A destructive action on work that exists nowhere else needs a copy, not a better warning. The user saw the folder, so a warning would not have stopped them.

## What to do differently

- Retry a failed environment probe after a cooldown (30 s, `env.rs` `LoginPathCache`), and make spawns wait for a probe already in flight.
- Show an in-progress operation on the row: [[component_operation_watch]].
- Keep a copy before removal whenever the worktree holds work no ref does, and stop the delete if the copy fails: [[component_rescue_copies]].

Rejected on the way: raising the probe timeout (a slower shell hits the new limit), retrying spawns on `ENOENT` (a second path for the same fix), setting `branch` to the rebase's head name everywhere (31 callers of `list_worktrees_body`, and cleanup must not act mid-rebase), and keeping the trashed folder instead of a commit (`node_modules` and disk).

## Related

- [[gotcha_gui_launched_processes_inherit_a_minimal_path]]
- [[gotcha_list_worktrees_body_names_a_detached_head_detached]]
- [[component_worktree_lifecycle]]
