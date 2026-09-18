---
summary: deleting a field from a serde struct with deny unknown fields fails every file on disk, keep it as a legacy skip field
status: current
updated: 2026-08-14
source: Defer permissions to the harness, and grow to four harnesses, phases 2 and 9 (personal/tori, branch `chat-fix`); `src-tauri/src/settings.rs`
---

# `deny_unknown_fields` makes a deleted field a migration

Do NOT simply delete a field from a serde struct carrying `deny_unknown_fields`: every file already on disk still has the key, and strictness turns all of them into parse failures at once. Read what the failure path then does before assuming it degrades - for `RuleFile` it meant "written by a Tori I do not know", which answered by denying every tool call. Keep the key as a `legacy_` field, read and `skip_serializing`, so the next write heals the file. Conversely, a struct **without** `deny_unknown_fields` (`ChatDefaults` in `settings.rs`) can drop a field freely: the old key parses, is ignored, and disappears on the next save. Check which one you have.
