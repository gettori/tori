---
summary: radar.rs keeps each branch's base conflicts and cross-worktree overlaps in Rust, cache plus coalesced sweeps, emits only on change
status: current
updated: 2026-10-12
source: Conflict radar plan (branch `phase-1-block-2`, gettori/tickets#33); commits 8bf7aed9, 7cfd89cb, e15376c2; `src-tauri/src/radar.rs`, `src-tauri/src/git.rs` (`unit_conflicts`, `changed_since_base`, `worktree_roots`), `src/utils/radar.ts`, `src/utils/branchSync.ts`
---

# Conflict radar

`src-tauri/src/radar.rs` answers two questions per branch unit before a pull request exists: would a merge of the base conflict, and is a live session in another worktree of the same repo changing the same files.

## Responsibility

- **Base conflicts** per unit (folder, branch), from `git::unit_conflicts`: the existing `merge-tree --write-tree` check, cached on (common dir, head sha, base sha). A read through `git_branch_sync` computes on a miss and leaves its answer here (`note_read`), never announcing it.
- **Sweeps** run on one thread fed by an mpsc queue, coalesced per batch. A fetch or a re-pointed base (`moved`) re-asks every watched unit sharing the repo's common dir. A turn end (`committed`) re-asks only that folder plus units whose base is a local branch, the only base a local commit can move. Watched means a drawn row (replaced whole by `radar_set_drawn` on every `syncUnits`), a live session's folder, or an open autopilot item's worktree; at startup only autopilot items.
- **Overlaps**: per live session (any state but Ended), a cached `SessionWrites`: its touched records relative to the worktree root, kept while `changed_since_base` still lists them. Intersected across worktrees of one common dir, never within one; each overlap is listed from both sides. `Job::Sessions`, sent whenever `SessionStates::replace` emits, computes only new sessions and runs no base sweep. See [[adr_an_overlap_is_two_live_sessions_recorded_writes]].
- **The switch**: `settings.conflictRadar.enabled`, default on, cached on settings.json's mtime. Off returns before any git call or touched read, clears answers and overlaps and announces the clear. A sweep that was mid-flight when it went off checks `was_enabled` under the lock and drops its result.
- It does not own the fetch schedule (the webview's `remoteSync.ts`) or same-worktree sharing (`shared_with`, [[component_turn_checkpoints]]).

## Interface

- Out: `radar://changed` to the webview and `radar.changed` on the hub's `sessions` topic, carrying `Changed { units, overlaps? }` only for answers that differ. Every phone screen already ignores unknown kinds, and the phone Inbox re-pulls on any `sessions` event.
- Reads: RPC `radar.list` (local and devices) and Tauri `radar_list` return `Listing { enabled, units, overlaps }`. `session_signals(id, folder)` feeds [[component_review_inbox]]; `view(worktrees)` feeds the autopilot rows ([[component_autopilot_store]]).
- Triggers in: `moved` (fetch done, quiet or not; `git://base-changed`), `committed` (chat `TurnCompleted`), `sessions_changed`, `settings_changed` (settings watcher and `set_settings`).
- Webview: `branchSync.ts` resyncs drawn rows on a folder the event names; `src/utils/radar.ts` holds overlaps (`watchRadar`, `overlapsOf`, `overlapsAt`). Surfaces: the sidebar's amber `overlap` SyncMark (kept while an agent holds the row), a `TabMark` corner on tabs and History rows, and an "Also open in" label in Checkpoints that never touches the revert confirm.

## Related

- [[adr_rust_composes_the_dot_from_reported_facts]]: why the answer lives in Rust and every client reads it
- [[adr_an_overlap_is_two_live_sessions_recorded_writes]]: what counts as an overlap
- [[concept_one_directory_two_spellings]]: why `worktree_roots` matches two spellings
- [[gotcha_settings_search_is_fuzzy_so_a_new_row_moves_match_counts]]: the test the setting's row broke
