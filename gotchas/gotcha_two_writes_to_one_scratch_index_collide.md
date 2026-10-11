---
summary: two git add -A runs on one scratch index fail on index.lock, and a failed prompt snapshot is a lost checkpoint
status: current
updated: 2026-10-12
source: "Review inbox plan (branch `phase-1-block-2`, gettori/tickets#32); commits fb28a0fb, 6fe8ba85, d95439d9; `src-tauri/src/checkpoint.rs` (`write_tree_scratch`, `INDEX_LOCKS`)"
---

# Two writes to one scratch index collide

Do NOT run `git add -A` with a session's `GIT_INDEX_FILE` outside `write_tree_scratch`. The timeline, the prompt snapshot and the review inbox's `live_tree` all write the same per-session index, and two at once fail on its `index.lock`. A failed `checkpoint_snapshot` is swallowed by the frontend, so the turn silently has no checkpoint. `write_tree_scratch` holds a lock per index path; any new caller goes through it.

## Related

- [[component_turn_checkpoints]]
- [[component_review_inbox]] the caller that exposed it
