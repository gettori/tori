---
summary: a bare TOML key after a table header becomes a field of that table, not top level, with only a warning
status: current
updated: 2026-07-18
source: "Prove the adapter: opencode + claude hooks (personal/sway, branch `topbar`); Phase 2; `src-tauri/agents/opencode.toml`; commit 8505b27"
---

# A TOML key after a table header belongs to that table

Do NOT place a top-level key (e.g. `verified_against = "..."`) after a `[table]` header in an adapter TOML expecting it to stay top-level; TOML bare keys belong to the most recently opened table until another header appears. Why: `opencode.toml` originally had `verified_against` after `[capabilities]`, so it silently parsed as a field *inside* `[capabilities]` (an unknown-field warning only, not a hard error) and `AgentAdapter.verified_against` stayed `None` — caught by a test assertion, not by inspection. Put every top-level field (`schema_version`/`id`/`label`/`verified_against`) before the first `[table]` header.
