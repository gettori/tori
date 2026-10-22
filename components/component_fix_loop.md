---
summary: rpc/fix_loop.rs keeps item watches in step with items, plans their news (rerun once per check per head, the stop), marks rows
status: current
updated: 2026-10-22
source: gettori/tickets#45 on branch fix-ci-until-green, plan "Fix CI until green, then ask to merge"; commits 02c357b4, 04ab48cd; src-tauri/src/rpc/fix_loop.rs, src-tauri/src/rpc/office.rs (autopilot_publisher, fix_loop_sync, republish_item), src-tauri/src/rpc/pr_watch.rs (fold)
---

# Fix loop

`src-tauri/src/rpc/fix_loop.rs`: the fix loop's side of an autopilot item's own pull request watch.

## Responsibility

- **Which items hold a watch.** `wants_watch`: an open `Kind::Ship` item with a GitHub `pr_url`, in a project whose `prFixLoop` entry exists. `reconcile` (pure) answers the watches to start and the item ids whose watch should go. `sync(items)` applies it to every item, from `Office::fix_loop_sync` after each fold and at daemon start; `sync_item(item)` applies it to one, from the autopilot publisher on every `autopilot.changed`. A new watch's `branch` is the item worktree's current branch; without one it is not polled outside the active space.
- **What the news says.** `plan(&mut Watch, stop_on_review)` drains `pending` into a `Plan`: a failed check with a numeric run id whose name is not in `Watch.reran` is queued for a rerun and recorded, anything else becomes `What::CheckFailed("<name>, run <id>")`; `Passed`, `Conflicting` and `Ended` become `ChecksPassed`, `Conflicting` and `Pr(why)`; a bot remark is dropped; a person's remark is told as `Remark("@who[, verdict]")` and, with `stop_on_review` and not an approval, sets `Watch.stopped`. Text from GitHub goes through `pr_watch::clean` ([[gotcha_a_tori_note_body_can_close_its_own_note]]).
- **The tick.** `tick()`, after each fold: plans every item watch with news under the store lock, then outside it runs each rerun through `forge::commands::rerun_check` (a refusal is told as the failure, `rerun_or_tell`), hands the lines to `watcher_fix_news`, and re-publishes an item whose loop just stopped (`Office::republish_item`).
- **Rows.** `mark_stopped(row, watches)` adds `fix_stopped` to a row, used by `autopilot.state` and by the publisher on each `autopilot.changed`.

It does not push, gate or merge: the gate is `fix_gate` in `pr_push`, the merge card is the brief's.

## Interface

- `sync`, `sync_item`, `tick`, `mark_stopped`, `plan`, `reconcile`, `wants_watch`, `check_failed`.
- Reads `settings::pr_fix_loop`, the `pr_watch::store()`, and `autopilot` items handed in.

## Related

- [[adr_the_fix_loop_pushes_unasked_and_merges_only_on_a_card]]: why it is shaped this way
- [[component_pr_watch]]: the watch record and fold
- [[component_autopilot_watcher]]: the lines it feeds
- [[component_autopilot_store]]: the items and their `fix_pushes`
