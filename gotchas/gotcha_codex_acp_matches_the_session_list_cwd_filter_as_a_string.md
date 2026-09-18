---
summary: codex-acp compares the session list cwd filter as a string, a resolved path versus its stored path returns zero rows
status: current
updated: 2026-08-15
source: Make a harness installable, signed in, and discoverable, phase 6 (personal/tori, branch `harness-lifecycle`); `src-tauri/src/chat/acp_transport.rs` (`refresh_listing`); [[concept_one_directory_two_spellings]]
---

# `codex-acp` matches the `session/list` cwd filter as a string

Send the **resolved** path in `ListSessionsRequest.cwd`. `@agentclientprotocol/codex-acp` 1.2.0 compares the filter against the cwd it recorded, as a string, so a directory macOS hands out as `/var/folders/...` and Codex stored as `/private/var/folders/...` returns **zero rows** while the thread sits in `~/.codex/state_5.sqlite` with the right path. It looks exactly like an agent that advertises `sessionCapabilities.list` and has nothing to list, which is a real behaviour of other agents (`opencode acp` 1.18.3), so it is easy to write off. Note also that codex-cli 0.147.0 keeps threads in that SQLite state store, not in the older `~/.codex/sessions/*.jsonl`. And fix the return leg in the same change: a row Tori has never seen adopts the agent's spelling, which the sidebar's prefix match then hides, so canonicalizing only the filter makes rows arrive invisible.
