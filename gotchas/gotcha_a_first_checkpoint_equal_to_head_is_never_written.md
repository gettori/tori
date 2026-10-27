---
summary: a turn whose tree equals its prior writes no checkpoint, so a test repo must change a file before the first snapshot
status: current
updated: 2026-10-27
source: gettori/tickets#46 on branch agents-launching-agents, plan "Agents launching agents: wait reasons, check, handoff, loop", commit 78628446; src-tauri/src/checkpoint.rs (write_snapshot, session_stat tests)
---

# A first checkpoint equal to HEAD is never written

Don't take `checkpoint_snapshot_body` at the first prompt of an untouched test repo and expect a checkpoint: `write_snapshot` skips any tree equal to its prior, and with no checkpoint yet the prior is HEAD's tree, so the session's checkpoints start one turn later and a range or stat is off by that turn. Why: an unchanged tree is deduped on purpose, so a turn that wrote nothing costs no ref. Write a file before the first snapshot, as the range diff tests do with `base.txt`.

## Related

- [[component_turn_checkpoints]]: snapshots and their refs
- [[gotcha_checkpoint_range_diff_files_carry_no_line_counts]]: the other surprise in the same range diff
