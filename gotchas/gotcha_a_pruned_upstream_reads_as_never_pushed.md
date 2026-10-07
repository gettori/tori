---
summary: after fetch --prune a deleted upstream resolves to nothing, so read branch.<name>.merge to tell deleted from never pushed
status: current
updated: 2026-10-08
source: "plan "Show merged and closed PR status on worktree rows" (personal/tori, branch `misc-20260927`); commits 662596f1, 6cfe26b5, 2d139c7e, 4d8a5c5d; `src-tauri/src/git.rs:2703` `upstream_gone`"
---

# A pruned upstream reads as never pushed

Do NOT treat "no upstream ref resolves" as "never pushed": once the remote branch is deleted and a `fetch --prune` runs, the tracking ref is gone too and the branch looks brand new. Check `git config branch.<name>.merge`; set with nothing behind it is `gone`. Why: the config survives the prune, the ref does not. A branch pushed from the CLI without `-u` has no config, so it still reads as never pushed.

## Related

- [[concept_a_finished_pull_request_is_kept_by_relation]]
- [[component_worktree_cleanup]] - the merge rule checks ancestry against the merged PR's head instead
