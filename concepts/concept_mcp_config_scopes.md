---
summary: Tori reads claude's three MCP scopes, writes only .mcp.json, injects tori mcp via --mcp-config with its tools pre-allowed
status: current
updated: 2026-09-24
source: plan "Native Claude chat as the default session surface" (phase 12), branch `chat`; `src-tauri/src/chat/mcp.rs`; `src/panels/Chat/SessionInfo.tsx`; plan "Probe: --mcp-config beside --settings" (phase 2), branch `orchestrator`; `dev/mcp-probe.mjs --scopes`; plan "tori mcp" phase 2, same branch, the `injection` block of `--scopes` on claude 2.1.280; commit cee102ec, src-tauri/src/rpc/mod.rs (mcp_config_args, mcp_allow)
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

## The injected fourth source: `--mcp-config`

Measured on claude 2.1.280 with `node dev/mcp-probe.mjs --scopes` (phase 1's calibration ran on 2.1.278). This is how Tori hands a session its own server without writing any of the three files above.

- **It merges, it does not displace.** Passed beside the injected `--settings <path>` at default setting sources, the server loads with `source: "dynamic"` and connects, its tools appear as `mcp__<name>__<tool>`, the turn reaches `result/success`, and the `--settings` hook still fires through `Stop`. In a project holding a `.mcp.json`, the project server stays `source: "project"`, `connected` with and without `--mcp-config`, and the claude.ai connectors stay too.
- **It is not persisted with the session.** `--resume <id>` with `--mcp-config` present brings the server back. `--resume <id>` without it and the server is gone from `mcp_servers` and `tools`. Tori has to pass the flag on every spawn, resumes included.
- **`--strict-mcp-config` replaces every other source.** With it, only the `dynamic` servers are left: the project `.mcp.json` server and every claude.ai connector drop out, and with no `--mcp-config` at all the array is empty. **#200 must not pass it**, since it would silently strip the user's own servers from every Tori-launched session.
- **The flag is variadic.** `--mcp-config <configs...>` takes several files or JSON strings and eats every bare token after it, so a prompt passed as a positional after it gets read as a config. Put another flag after the configs, or send the prompt over stream-json stdin.
- **The injected file also carries the per-server `timeout` (ms)**, the one knob that lets a blocking call outlast claude's 30 minute idle default, see [[concept_blocking_tool_call_ceiling]].
- **A bare `command` resolves through the claude process's PATH.** A config naming `command: "toriprobe"`, found only through a link in a directory the probe put first on PATH, starts and answers. So Tori's config can say `command: "tori"` and lean on the `bin/tori` link; no absolute exe path needed.
- **The server inherits claude's environment with no `env` in the config.** Two marker vars set on the claude process (`TORI_SOCK`, `TORI_CALLER`, probe-unique values) reached the server child, so one static config works for every session and the per session token rides the env Tori already sets.
- **An allow rule in the injected `--settings` silences the prompt.** Under `--permission-mode default --permission-prompt-tool stdio`, the same call raised a `can_use_tool` for `mcp__toriprobe__tori_probe_ping` with an empty settings file (the calibration) and raised none with `permissions.allow: ["mcp__toriprobe__*"]`. The wildcard form works in a settings file passed by flag, so no per session settings file is needed for it.
- **`source` names provenance directly** (`dynamic`, `project`, `claudeai`), so displacement reads off the label rather than from diffing two arrays.

### What Tori injects

Every Tori launched claude session, chat or PTY tab, spawn or resume, gets `--mcp-config ~/.config/tori/claude-mcp.json`, one static file naming `tori` with `command: "tori", args: ["mcp"]` and no `env` ([[component_tori_mcp]]). It goes directly before `--settings`, so the variadic flag stops at a flag. Both injected settings files (the per session one from `approval::settings_args` and the PTY one from `hooks`) carry `permissions.allow: ["mcp__tori__*"]`, so Tori's own tools never prompt. The user's deny rules still outrank it. That pre-allow is a recorded narrowing of `tori-harness-owns-permissions`, see [[adr_a_background_session_needs_a_tori_gate]].

Two things read like approval state and are not. An unapproved `.mcp.json` server comes up `connected` under `-p`, which is what the chat transport runs, so the pending state in [[gotcha_a_newly_written_mcp_json_server_is_pending_not_connected]] was measured on the interactive surface (`claude mcp list`) and does not gate a print-mode session. And a claude.ai connector often shows `pending` in `system/init` because it had not finished connecting when the turn opened, not because anything is waiting on the user.

## Related

- [[component_chat_panel]] - the SessionInfo disclosure that lists and edits these
- [[concept_pretooluse_capture_hook]] - the same never-write-their-state boundary
- [[gotcha_claude_json_is_live_application_state_not_a_config_file]]
- [[gotcha_a_newly_written_mcp_json_server_is_pending_not_connected]]
- [[component_tori_mcp]]: the server Tori injects this way
