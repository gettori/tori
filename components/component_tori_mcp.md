---
summary: `tori mcp` is a stdio MCP server over the socket's method table: tools listed per caller kind, one connection per call
status: current
updated: 2026-09-24
source: plan "tori mcp: the MCP front on the socket" on branch orchestrator; commits b69f5ada, 1fbc5991, cee102ec, 5963da85, 928f500e, 12bcab53, a375fb7a; src-tauri/src/mcp.rs; src-tauri/src/rpc/table.rs; src-tauri/src/rpc/mod.rs (mcp_config_args, mcp_launch, mcp_allow); plan "Approval gate for background sessions" (gettori/tori#203) on branch orchestrator, commits 277c772e, 66dbe76d and 4f3069ce
---

# tori MCP server

`src-tauri/src/mcp.rs` is the second front on the app socket: `tori mcp`, the app binary in CLI mode speaking MCP over stdio. Every Tori launched claude session gets it, and so does every ACP session whose adapter sets `send_mcp_servers`.

## Responsibility

It turns MCP's `tools/list` and `tools/call` into socket calls and holds no logic of its own ([[adr_one_protocol_several_fronts]]). Defaults, refusals and lookups stay in the socket ([[component_app_socket]]), so a tool and its `tori` CLI command ([[component_tori_cli]]) always answer the same way.

What it owns is only what MCP needs and the socket cannot know:

- **Tool names.** The method with `.` as `_` (`sessions_list`, `session_spawn`), no `tori_` prefix, since claude already shows `mcp__tori__<tool>`.
- **Relative paths.** `folder`, `project` and `path` are made absolute against the caller's cwd from `caller`, because the socket would read them against the app's.
- **The blocking default.** `ask_create`, `ask_wait` and `session_wait` get `timeout: 240` when the agent leaves it out, under codex-acp's 300s kill ([[concept_blocking_tool_call_ceiling]]).

## How it works

- **One table, two readers.** `rpc/table.rs` holds `METHODS`: name, description, a `schemars` params schema, the caller kinds admitted, and the call. The dispatcher and `tools/list` both read it, so a new row is served and published at once. The params structs' field doc comments are the tool parameter descriptions, so they stay even where a comment cleanup would cut them.
- **Caller kinds.** `Local`, `Terminal`, `Chat`, `Worker`. `Backend::kind` resolves `Worker` from the worker mark in `SessionStates`. A row that leaves a kind out is refused by the dispatcher and left out of the list, so the list never advertises a tool the socket will refuse.
- **The list is computed per request.** `tools/list` asks `caller` for the kind each time. The worker mark lands just after the spawn reply and the child's server starts later, but nothing orders the two, so a list cached at startup could miss it.
- **One socket connection per call, each on its own thread.** The socket dispatches one request at a time per connection, so a blocking `ask_create` on a shared connection would stall a `sessions_list` behind it. A socket error comes back as a tool result with `isError: true`, so the agent reads the refusal text.
- **Handshake.** `initialize` echoes the client's `protocolVersion`; `ping` answers `{}`; notifications get no reply, including opencode's `notifications/cancelled` for an id already answered ([[concept_acp_agent_quirks]]).

## Launch

- **claude**: one static `~/.config/tori/claude-mcp.json` (`command: "tori", args: ["mcp"]`), passed as `--mcp-config` on every spawn and resume. The server finds `tori` through the `bin/tori` PATH link and inherits `TORI_SOCK` and `TORI_CALLER`. The injected settings pre-allow Tori's tools per session: `mcp__tori__*` for a background session, every row not marked `outward` by name otherwise, so `pr_create`, `review_submit` and `pr_merge` prompt in the foreground. See [[concept_mcp_config_scopes]].
- **ACP**: `session/new` and `session/load` carry one stdio server whose command is the `bin/tori` link, with `TORI_SOCK` and `TORI_CALLER` as `env` pairs minted for that session (`rpc::mcp_launch`). Only when the adapter sets `send_mcp_servers` (codex, opencode). pi-acp drops the array.

## Workers

A session spawned by a chat session is a worker. It is refused `session_spawn`, `session_steer`, `session_wait` and `ask_answer`, none of which its list shows, with "a worker never spawns or steers; finish your turn and your spawner reads it". Its questions are not refused: `ask_create` puts the card in the worker's own panel, and the spawner sees the same question in `session_wait`'s reply (`{id, state, question, last}`) and can relay it and settle it with `ask_answer`. Whichever side answers first settles the ask. A permission pending in the worker shows up in `session_wait` only as `needs_you` with `question: null`. An approval ask is the exception to the spawner answering: `ask_answer` refuses it, and its card is mirrored into the worker's root background chat so the user sees it there ([[adr_a_background_session_needs_a_tori_gate]]).

## Related

- [[component_app_socket]]: the table, the dispatcher and every method a tool calls
- [[component_tori_cli]]: the first front, same binary, same calls
- [[adr_one_protocol_several_fronts]]: why this front is thin
- [[concept_mcp_config_scopes]]: how claude is handed the server without writing its config
- [[concept_acp_agent_quirks]]: which ACP agents honour `mcpServers`
- [[concept_blocking_tool_call_ceiling]]: why the blocking default is 240s
- [[adr_a_background_session_needs_a_tori_gate]]: why pre-allowing these tools is a recorded narrowing
- [[adr_a_workers_questions_bubble_up_to_its_spawner]]: why a worker asks rather than being refused
