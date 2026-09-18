---
summary: a removed adapter smuggled a sqlite backed session through the existing path field as a synthetic locator string
status: stale
updated: 2026-07-31
source: "Prove the adapter: opencode + claude hooks (personal/tori, branch `topbar`); Phase 2; `src-tauri/src/opencode.rs`, `src-tauri/src/sessions.rs`"
---

# Locator scheme for DB-backed sessions

> **Removed 2026-07-31.** opencode was unbundled (branch `navigation`, phase 8,
> commit e6d98c2), taking `opencode.rs`, `ParserKind::OpencodeSqlite`,
> `Discovery::Sqlite` and every locator guard with it. **This page is kept
> deliberately**, not as current code but as the one worked example of what a
> database-backed adapter costs: `ADAPTERS.md` now tells an adapter author that
> such an agent needs both a new parser kind and a new `discovery.backend`, and
> this is what that sentence is pointing at. `Discovery` is a single-variant
> enum matched exhaustively at three transcript readers, so reintroducing the
> shape means answering at each of them rather than smuggling it through a
> specially-shaped path again.

Tori's session model is file-path-centric: `SessionMeta.path` is a real jsonl file, and half a dozen functions in `sessions.rs` (`session_detail`, `extract_touched_files`, `parse_transcript_turns`, `session_prompt_tail`, `delete_session`, `touched_files_cached`'s mtime check) take that path and read/stat it directly. opencode breaks that assumption completely — its sessions have no per-session file at all, every session's messages/parts are rows in one shared SQLite DB covering every project on the machine. Rather than restructure those six functions into an abstraction over "a session's backing store" (a materially bigger diff, touching claude/pi's working code paths too), the DB-backed case is smuggled through the *existing* string-typed `path` field.

## How it works

`opencode::make_locator(db_path, session_id)` builds a synthetic string `opencode-sqlite:<db path>#<session id>` and stores it as `SessionMeta.path` for every opencode session (`opencode.rs`). Each of the six path-consuming functions in `sessions.rs` gets one early-return guard at the top:

```rust
if let Some((db_path, session_id)) = crate::opencode::parse_locator(&path) {
    return crate::opencode::<same-shaped-function>(&db_path, session_id);
}
```

The guarded function delegates to a same-shaped counterpart in `opencode.rs` that queries the DB instead of reading a file. Everything downstream of `SessionMeta` (the frontend, `list_sessions`, drag-and-drop) treats `path` as an opaque round-tripped string it never opens directly — confirmed by grep before relying on it, not assumed.

`touched_files_cached`'s cache-freshness check is the one place this needed real care: `std::fs::metadata` on a synthetic locator always fails, which would silently freeze the cache at `SystemTime::UNIX_EPOCH` forever (never invalidating after the first read). The locator branch uses `opencode::mtime_for` (the DB's own `time_updated` column) instead of a filesystem stat.

Session deletion follows the same "delegate, don't reimplement" shape but for safety rather than shape: `delete_session` shells out to `opencode session delete <id>` (mirroring `session_running`'s existing pgrep-shelling pattern) rather than issuing a raw SQL `DELETE`, since the DB's foreign keys aren't cascade-safe without `PRAGMA foreign_keys=ON` and Tori doesn't own opencode's data-integrity rules. The DB itself is opened strictly read-only (`SQLITE_OPEN_READ_ONLY`) everywhere Tori reads from it.

## Why it's this way

A generic "session backing store" trait/enum dispatched from every call site was the more "correct" refactor, but it would have touched claude/pi's already-working, already-tested code paths for a feature (opencode) that only needed six new *branches*, not a rewrite of the old ones. The locator string is a pragmatic seam: it fits the existing `String` field with zero schema change to `SessionMeta`, and every guard is a two-line early return rather than a new abstraction layer. The cost is that "is this session locator-backed" is a runtime string-prefix check rather than a type-level distinction — acceptable here because the check lives in exactly one place (`parse_locator`) and every call site already funnels through it.

## Related

- [[component_agent_adapter_registry]] — `Discovery::Sqlite` is the adapter-schema half of this; the locator scheme is the session-model half.
- [[component_session_worklog]] — the six functions this pattern guards.
