---
summary: ChatState mints ids from a per-run counter, so an entry restored from disk can collide with one minted this run unless it is re-ided
status: current
updated: 2026-10-05
source: plan "Queue upgrades: blocks, queue key, row actions, edit, persist" (branch `steer-message-uprades`, ticket gettori/tickets#8); `src/panels/Chat/chatStore.ts:738` (nextId), `:2019` (restoreQueue)
---

# A restored queue entry needs a fresh id since nextId restarts each run

Don't put an id saved by an earlier run back into `ChatState` as is. `nextId(s, prefix)` (`src/panels/Chat/chatStore.ts:738`) counts from `s.seq`, which starts at zero in every `initialChat`, so a queue entry saved as `q3` and restored next launch shares its id with the third thing this run mints. Remove, reorder, edit and steer all address entries by id, so the collision hits the wrong row. `restoreQueue` re-ids every entry through `nextId` as it comes back. Why: the id is only unique within a run, and nothing on disk is.

## Related

- [[concept_composer_queue]]: where the restore happens
