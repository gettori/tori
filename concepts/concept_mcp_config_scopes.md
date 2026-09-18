---
summary: Tori reads all three claude MCP scopes but writes only mcp json, because claude json is live app state it must not race
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (phase 12), branch `chat`; `src-tauri/src/chat/mcp.rs`; `src/panels/Chat/SessionInfo.tsx`
---

# MCP config: three scopes, read all, write one

Tori reads and writes Claude's own MCP configuration rather than inventing a format, because a server added in Tori has to be the same server `claude` sees from a terminal. It reads all three of Claude's scopes and writes only one of them.

## How it works

Measured against claude 2.1.220 (`claude mcp add --scope local|user|project`):

| Scope | File | Key |
|---|---|---|
| project | `<repo>/.mcp.json` | `mcpServers` |
| user | `~/.claude.json` | `mcpServers` |
| local | `~/.claude.json` | `projects[<cwd>].mcpServers` |

`merge_scopes` folds them with the narrowest definition winning, so a name defined in several scopes appears once, as the one Claude will actually use. Server definitions are passed through as raw JSON rather than parsed into a Tori shape, so a transport we do not model (HTTP with headers, something newer) round-trips intact.

Approval state is read from `projects[<cwd>].enabledMcpjsonServers` / `disabledMcpjsonServers`, including the `"*"` wildcard, and is scoped to the current cwd so an approval recorded against another project never leaks.

## Why it's this way

**`~/.claude.json` is not a config file, it is Claude's live application state** - ~90 top-level keys of onboarding flags, caches, per-project token totals and OAuth account, rewritten by every running `claude`. A read-modify-write from Tori would race those writers and could drop unrelated state nobody asked us to touch. This is the same boundary the project already draws at `~/.claude/settings.json` in [[concept_pretooluse_capture_hook]], for the same reason.

`.mcp.json` has none of those problems: small, single-purpose, checked in, and designed to be shared. So Tori writes there and reports the other two read-only. Writes preserve sibling keys and pretty-print with a trailing newline, because the file is meant to be reviewed in a diff.

The accepted consequence is that a newly written server is **pending**, not connected - the approval lives in the file we will not write. Tori reports that state with the instruction for clearing it rather than force-enabling it behind the user's back. Verified end to end: writing a `.mcp.json` and running `claude mcp list` reported `⏸ Pending approval`.

## Related

- [[component_chat_panel]] - the SessionInfo disclosure that lists and edits these
- [[concept_pretooluse_capture_hook]] - the same never-write-their-state boundary
- [[gotcha_claude_json_is_live_application_state_not_a_config_file]]
- [[gotcha_a_newly_written_mcp_json_server_is_pending_not_connected]]
