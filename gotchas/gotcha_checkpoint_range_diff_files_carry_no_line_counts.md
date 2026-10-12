---
summary: checkpoint_range_diff's files come from name-status, added and removed are always 0; count from the patch, inside hunks
status: current
updated: 2026-10-12
source: "Morning digest plan (gettori/tickets#37); `src-tauri/src/checkpoint.rs` (`range_diff_one`, `session_lines_since`)"
---

# checkpoint_range_diff files carry no line counts

Do not sum `added` and `removed` from the files `checkpoint_range_diff` returns: they are built from `--name-status` and are always 0. Count lines from its patch, only inside hunks, since a removed line starting with `---` looks like a header. Why: only the single-turn path runs numstat. Its `ts` values are epoch seconds, not the ms the needs-you log uses.

## Related

- [[component_turn_checkpoints]]
- [[component_digest]]
