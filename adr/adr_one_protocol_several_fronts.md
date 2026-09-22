---
summary: one json-rpc protocol on an app level socket, with the cli, the mcp server and a later websocket as fronts on it
status: current
updated: 2026-09-23
source: "design conversation 2026-09-23 captured in gettori/tori#194; ticket gettori/tori#195; implemented by gettori/tori#197, #198, #199 and #200; no code yet, decision precedes first implementation"
---

# One protocol on one socket, and every front is a client of it

**Tori exposes what only Tori knows over a single JSON-RPC protocol on an app level socket, and every way in is a front on that one protocol.** The `tori` CLI, the MCP server and later a WebSocket for a phone all speak it; none of them gets a surface of its own. What rides the protocol is bounded by a second rule that ships with this one: only the things Tori alone can answer, which are sessions, agents, accounts, checkpoints, worktrees, budgets and the window. Git, files and the forge stay off it, because an agent already reaches those without asking Tori.

Today there is no app level surface at all. The sockets that exist are per session and single purpose: the askpass bridge ([[concept_askpass_bridge]]) and the capture hook ([[concept_pretooluse_capture_hook]]), each serving one session's helper. Nothing outside the webview can ask what sessions are running.

## Considered Options

- **No backend at all, the webview stays the only surface** (rejected): it cannot answer the question that starts everything. A CLI in a PTY tab, an MCP server in a spawned session and a phone are all outside the webview, and the webview's own IPC cannot be reached from any of them. The one seam that does intercept `invoke` is a build time alias inside the webview ([[gotcha_the_tauri_internals_invoke_cannot_be_hooked_at_runtime]]), which is no help to a process outside it either.
- **A surface per front** (rejected): the CLI talking to Tauri commands, the MCP server carrying its own logic, the WebSocket its own server. Every capability would then be written once per front and would drift three ways, and the MCP server in particular has no reason to hold logic: it is one tool per CLI command forwarding over the socket, so a second implementation buys nothing. The CLI is the front that comes first because it works for every agent including a PTY tab, needs no config, and can be scripted.
- **A fat protocol that also fronts git, files and the forge** (rejected): it would duplicate what the agent can already do for itself, and each addition is a surface Tori then owns forever. The forge is the sharpest case, since Tori's own client exists to feed the sidebar and its poll layer is shaped around a request budget ([[concept_forge_rate_budget]]), not around answering arbitrary calls from an agent.
- **One protocol, several fronts** (chosen): one dispatcher, one auth step, one subscription model, and a front is a thin translation into it.

## Consequences

- **The transport is a trait from the first commit, not a later refactor.** A Unix socket now, a TCP or WebSocket listener later, reusing the framing, the auth step and the dispatcher untouched. That is the only thing the phone needs from the first ticket, and retrofitting it after three fronts exist would mean changing all three.
- **Auth is its own function because it is the part that changes.** The socket carries a token, in the same private `0700` directory under `$TMPDIR` the existing bridges use. A WebSocket front will carry a per device credential instead, and that swap has to stay local to one function. [[gotcha_darwin_caps_unix_socket_paths_at_104_bytes]] constrains where the path can live.
- **A spawned session finds the socket through its environment**, the way the existing helpers do, which is what lets a session Tori started call back into Tori without configuration.
- **The boundary rule is a second decision riding this page.** "One protocol with fronts" and "only what Tori alone knows" are separately reversible: a single fat protocol fronting git and the forge satisfies the first and breaks the second. An amendment that widens what is exposed belongs here, under this heading, rather than in a new page whose title is about fronts.
- **The MCP front inherits a trap that is not Tori's.** A server written into `mcp.json` loads as pending, not connected, and its approval lives in a file Tori deliberately never writes. See [[gotcha_a_newly_written_mcp_json_server_is_pending_not_connected]] and [[concept_mcp_config_scopes]].
- **Nothing here changes who decides a tool call.** A front is a way to reach Tori, not a new authority. The one narrowing is [[adr_a_background_session_needs_a_tori_gate]], and it is scoped to sessions flagged background.

## Related

- [[concept_askpass_bridge]] - the existing app level socket pattern this copies, re-exec the binary, private socket, token in env
- [[concept_pretooluse_capture_hook]] - the second use of that pattern, and the page that records why Tori decides no tool call
- [[concept_transport_neutral_event_model]] - the same shape one layer up, one normalized event enum behind every consumer
- [[adr_no_sync_ipc_commands]] - the rule any new command surface answers to, nothing that can block runs on the IPC thread
- [[adr_autopilot_is_a_session_not_a_state_machine]] - the first real consumer of this protocol
- [[adr_a_background_session_needs_a_tori_gate]] - the one narrowing of authority that rides it
