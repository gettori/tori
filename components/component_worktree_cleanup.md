---
summary: the cleanup sweep removes clean, merged or idle secondary worktrees from the webview; Rust only reports facts, the branch is the undo
status: current
updated: 2026-10-08
source: plan "Automatic worktree cleanup policy" on branch phase-1-block-1, ticket gettori/tickets#12; src-tauri/src/worktree_cleanup.rs, src/utils/worktreeCleanup.ts, src/utils/worktreeCleanupVerdict.ts
---

# Worktree cleanup

`src/utils/worktreeCleanup.ts` (the sweep), `src/utils/worktreeCleanupVerdict.ts` (the pure verdict), `src-tauri/src/worktree_cleanup.rs` (the facts). Removes secondary worktrees on its own when `git.cleanupAfterMerge` or `git.cleanupAfterIdleDays` is on. Both are off by default.

## Responsibility

Rust reports facts and decides nothing. `worktree_cleanup_facts(projectPath, mergedHeads?, mergedOnly?)` lists every secondary worktree except the main checkout, the bare record, a detached HEAD, a Topic member's `worktreePath` and a fan-out attempt. For each one it returns `dirty`, `unpushed`, `head`, `lastActivity` and `inMergedHead`.

- `lastActivity` is the newest of the admin dir's birth time, the last commit and the newest transcript anchored at or under the folder. The birth time is what stops a worktree created today off a nine-day-old base from reading as nine days idle.
- `inMergedHead` is `merge-base --is-ancestor HEAD <merged head>`. The merge rule can't use `unpushed`, because a merged branch's remote is usually auto-deleted and then reads as never pushed ([[gotcha_a_pruned_upstream_reads_as_never_pushed]]). Ancestry also accepts a local HEAD behind the PR, as after an upstream "Update branch". A head this clone never fetched fails the check, so the worktree is kept.
- Session activity is read once per call through the session index (`sessions::activity_by_cwd`), not once per worktree.

`cleanupVerdict` needs one rule to apply (merged and `inMergedHead`, or idle past the threshold and not unpushed). It then refuses on any of these, in order: dirty, a session working in the folder, the selection at or under it, an editor or terminal tab open under it, an autopilot item still working in it.

## How the sweep runs

- A full sweep runs over every project in `get_config` (every Space) at start, when either setting changes, and hourly. A forge report rechecks only its own project, with `mergedOnly` and the idle rule off. The forge poll only covers the active Space, so the merge rule does too.
- It is single flight. One trigger landing mid-sweep queues itself, and a second widens the queued work to a full sweep.
- For each removable row: `worktree_dirty` again, then `PURGE_UNDER_PATH`, then `remove_worktree` with `force: false`, so Rust's own dirty guard has the last word. The purge-first contract is the one every manual removal site follows ([[component_worktree_lifecycle]]).
- The session probe (`detachedCandidates`, which spawns `pgrep`) runs only for a row that every other check already lets go.
- One info toast per sweep names the removed branches. Add Worktree is the recreate path, since the branch is never deleted.

## Why it is this way

- **No provenance rule.** Nothing records that Tori created a worktree: the backstop id is minted at the first discard ([[gotcha_the_backstop_worktree_id_is_minted_at_first_backstop_not_creation]]). A new marker would never cover the worktrees that already exist. Clean, pushed and branch kept is the real safety.
- **No snapshot before removal.** The tree has to be clean, and the backstop sidecar lives in the worktree's admin dir, which `git worktree remove` deletes ([[concept_worktree_backstops]]).
- **Ignored files go with the folder**, as with manual removal. Blocking on them would need a list of regenerable dirs kept up to date.
- **The verdict runs in the webview** because the live tabs, the selection and the forge statuses all live there.
- **Rejected:** file mtime as idle (noisy from `node_modules` and build output), per-project overrides, and a suggest-only review dialog.

## Related

- [[component_worktree_lifecycle]]: the removal core and the purge contract
- [[concept_worktree_backstops]]: why there is nothing to snapshot
- [[gotcha_a_pruned_upstream_reads_as_never_pushed]]: why the merge rule checks ancestry
- [[concept_forge_rate_budget]]: why the merge rule stays inside what the poll already asks
