---
summary: a cache stamped on an input object's identity re-asks forever when two stores hand it equal but distinct objects
status: current
updated: 2026-09-27
source: "plan "Show merged and closed PR status on worktree rows" (personal/tori, branch `misc-20260927`); commits 662596f1, 6cfe26b5, 2d139c7e, 4d8a5c5d; `src/utils/prRelation.ts:30` `localStamp`"
---

# A cache stamped on object identity thrashes across two stores

## What happened

`prRelation` first refreshed when the sync object it was given changed identity. The sidebar row reads sync from `syncFor` and the Pull Requests panel from the git store, so the same branch arrived as two distinct objects. Each read saw a "new" stamp, asked git again, and overwrote the other's answer.

## What we learned

Identity is a per-store fact. A cache shared by readers of different stores has to stamp on content: the fields that actually move the answer.

## What to do differently

Name the fields that change the answer and build the stamp from them (`head_committed_at`, base behind, `gone` here). Check who else will read the cache before choosing identity. When stale replies can land out of order, keep the newest asked stamp and drop older replies.

## Related

- [[concept_a_finished_pull_request_is_kept_by_relation]]
- [[gotcha_setstore_with_an_empty_object_merges_rather_than_clears]]
