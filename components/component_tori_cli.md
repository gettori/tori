---
summary: `tori <cmd>` is the app binary in CLI mode: argv dispatch, a bin/tori link on child PATH, `tori mcp` as MCP front
status: current
updated: 2026-09-24
source: gettori/tori#198 on branch orchestrator; commits 2800ee38 through 85430c9e; src-tauri/src/cli.rs; src-tauri/src/rpc/client.rs; src-tauri/src/lib.rs (run); gettori/tori#199 commits 25551855, 3a04d580, 52615c71; plan "tori mcp" commits 1fbc5991, 12bcab53, a375fb7a; plan "Approval gate for background sessions" (gettori/tori#203) on branch orchestrator, commits 277c772e, 66dbe76d and 4f3069ce; gettori/tori#204 commits 424a5d26, aa67f28d, 29293fe2, 280f72e8
---

# tori CLI

`src-tauri/src/cli.rs` is the first front on the app socket: the same binary as the app, run as a short lived client before any Tauri init.

## Responsibility

It turns argv into one socket call (or a subscription, for `events`) and prints the answer, as a table or with `--json` as it came. It holds no logic of its own: defaults, refusals and lookups are the socket's ([[component_app_socket]]), so the MCP front can be one tool per command forwarding the same calls.

## Interface

- **Dispatch.** `lib.rs` `run()` checks helper modes in order: `credential::is_helper` (`--credential`), then `cli::is_cli()` (argv[1] is one of the command names), then the askpass and approval env helpers. A bare launch still opens the app.
- **Commands.** `sessions`, `session tail|wait`, `events`, `whoami`, `steer`, `worktree new`, `checkpoints`, `checkpoint diff <id> <n> [<m>]|revert`, `spawn`, `open`, `budget`, `ask` (`--wait <id>`, `--answer <id> <text>`, `--approval <json> [--project <path>]`), `pr create|review|merge`, `autopilot state|item|project|hold resolve`, `mcp`. `mcp` is not a command in the table sense: it runs the stdio MCP server ([[component_tori_mcp]]) until stdin closes. `session wait` prints the state, `asking <id>: <question>` when the session waits on one, and its last message. A worker session gets the socket's refusal for `spawn` and `steer`, same text as the MCP tools. `tori ask` prints `approval_id: <id>` on a second line after an Approve. `pr merge` requires `--head-sha`, and `pr review --event` takes `approve`, `comment` or `request-changes`. `steer` parses no flags, so a `--word` in the message stays part of it. `events` subscribes to `sessions` and `accounts` unless given `--topic`. `autopilot state` prints the items, then the contracts and holds when there are any. `autopilot item` without an id needs `--kind` and `--issue <key> --project` or `--pr <n> --repo <owner/name>`, and choice flags take dashes (`waiting-on-you`). The table writer `write_table` is shared with `sessions`.
- **Finding the app.** `rpc::client::locate` reads `TORI_SOCK` and `TORI_CALLER` first, then `~/.config/tori/rpc.json`, and says on stderr when it fell back to the file (an outside caller, with no defaults). A file naming a socket nobody serves (a crash left it behind) is reported as "Tori is not running".
- **On PATH.** The socket's private dir holds `bin/tori`, a link to the running binary, and every PTY and chat child gets it first on `PATH`. Two running copies each put their own binary first, and the link goes with the dir at exit.
- **Paths.** Relative paths (`--project`, `--folder`, `--attach`, `open <path>`) are made absolute here, because the socket would resolve them against the app's cwd.
- **Exit codes.** 0 on success, and on a broken pipe (`tori events | head`); 1 on an error; 2 when `tori ask` ran out of time, with the id on stdout to pass to `tori ask --wait`.

## Related

- [[component_app_socket]] - every method this calls
- [[component_tori_mcp]]: the MCP front, run as `tori mcp`
- [[adr_one_protocol_several_fronts]] - why the CLI is thin
- [[adr_socket_asks_the_webview_until_rust_owns_state]] - why `spawn`, `open`, `budget` and `ask` can time out naming the window
- [[gotcha_codex_shell_drops_env_names_containing_token_key_or_secret]] - why the caller token is `TORI_CALLER`
- [[concept_socket_event_vocabulary]] - what `tori events` prints
- [[component_autopilot_store]] - what `tori autopilot` reads and writes
