---
summary: `tori <cmd>` is the app binary in CLI mode: argv dispatch, a bin/tori link on child PATH, `tori mcp` as MCP front
status: current
updated: 2026-10-21
source: gettori/tori#198 on branch orchestrator; commits 2800ee38 through 85430c9e; src-tauri/src/cli.rs; src-tauri/src/rpc/client.rs; src-tauri/src/lib.rs (run); gettori/tori#199 commits 25551855, 3a04d580, 52615c71; plan "tori mcp" commits 1fbc5991, 12bcab53, a375fb7a; plan "Approval gate for background sessions" (gettori/tori#203) on branch orchestrator, commits 277c772e, 66dbe76d and 4f3069ce; gettori/tori#204 commits 424a5d26, aa67f28d, 29293fe2, 280f72e8; gettori/tori#207 commits 1b7e479d, 09ed97fa, aca065a5, 41e063de; gettori/tori#208 commit b25293df; gettori/tickets#24 phases tori-attach and launchd-install, commits 244f5b94, cdb81fa3; src-tauri/src/{cli,shell_path}.rs, src-tauri/src/pty/attach.rs; gettori/tickets#43 on branch scheduled-runs, plan "Scheduled runs", commits 0cdcf86b, ee900c1d, f5e7ccb4
---

# tori CLI

`src-tauri/src/cli.rs` is the first front on the app socket: the same binary as the app, run as a short lived client before any Tauri init.

## Responsibility

It turns argv into one socket call (or a subscription, for `events`) and prints the answer, as a table or with `--json` as it came. It holds no logic of its own: defaults, refusals and lookups are the socket's ([[component_app_socket]]), so the MCP front can be one tool per command forwarding the same calls.

## Interface

- **Dispatch.** `lib.rs` `run()` checks helper modes in order: `credential::is_helper` (`--credential`), then `cli::is_cli()` (argv[1] is one of the command names), then the askpass and approval env helpers. A bare launch still opens the app.
- **Commands.** `sessions`, `session tail|wait|pending|answer`, `events`, `whoami`, `steer`, `worktree new`, `checkpoints`, `checkpoint diff <id> <n> [<m>] [--why] [--json]|revert`, `spawn`, `open`, `budget`, `ask` (`--wait <id>`, `--answer <id> <text>`, `--approval <json> [--project <path>]`), `pr create|review|merge`, `autopilot state|item|project|hold resolve|schedule add|list|remove|resume`, `mcp`. `mcp` is not a command in the table sense: it runs the stdio MCP server ([[component_tori_mcp]]) until stdin closes. `session wait` prints the state, `asking <id>: <question>` when the session waits on one, and its last message. A worker session gets the socket's refusal for `spawn` and `steer`, same text as the MCP tools. `tori ask` prints `approval_id: <id>` on a second line after an Approve. `session pending <id> [--json]` lists what a session waits on; `session answer <session> <id> <text>...` sends one answer, `--each <text>...` one per question, and its arguments are checked before it connects. `spawn` takes `--model` and `--effort`. `pr create`, `pr review` and `pr merge` require `--head-sha`. `autopilot item` takes `--title` and `--contract`, and `pr review --event` takes `approve`, `comment` or `request-changes`. `steer` parses no flags, so a `--word` in the message stays part of it. `events` subscribes to `sessions` and `accounts` unless given `--topic`. `autopilot state` prints the items, then the contracts and holds when there are any. `autopilot item` without an id needs `--kind` and `--issue <key> --project` or `--pr <n> --repo <owner/name>`, and choice flags take dashes (`waiting-on-you`). `autopilot schedule add` needs `--name`, `--cron` and one of `--prompt` or `--issue`, and only `add` takes flags; `schedule list` prints ID, NAME, CRON, NEXT (or `paused`), PROJECT and WHAT. The table writer `write_table` is shared with `sessions`.
- **Finding the app.** `rpc::client::locate` reads `TORI_SOCK` and `TORI_CALLER` first, then `~/.config/tori/rpc.json`, and says on stderr when it fell back to the file (an outside caller, with no defaults). A file naming a socket nobody serves (a crash left it behind) is reported as "Tori is not running".
- **On PATH.** The socket's private dir holds `bin/tori`, a link to the running binary, and every PTY and chat child gets it first on `PATH`. Two running copies each put their own binary first, and the link goes with the dir at exit.
- **Paths.** Relative paths (`--project`, `--folder`, `--attach`, `open <path>`) are made absolute here, because the socket would resolve them against the app's cwd.
- **Exit codes.** 0 on success, and on a broken pipe (`tori events | head`); 1 on an error; 2 when `tori ask` ran out of time, with the id on stdout to pass to `tori ask --wait`.

`checkpoint diff --why` prints `# why` lines above each hunk, matched to the server's `why` list by file and hunk order, and only treats `+++ ` as a file header between `diff --git` and the first `@@`, since an added `++ ` line looks the same. The wording is in `claim_text` (`cli.rs:796`); `--json` prints the RPC result as is. The socket also has `provenance.hunks` for any file in a worktree. See [[component_provenance]].

## Attach, daemon and PATH (#24)

- `tori attach <session|tab>` (`pty/attach.rs`): raw mode with a restoring guard, a stdin thread, a resize thread, frames to stdout. It resolves a live PTY tab id, else a session through the composed tab list, in the daemon (`attach_target`). `Ctrl-\` detaches and is never sent; any end writes a mode reset (alt screen, cursor, mouse, bracketed paste) so the shell beneath is usable. It refuses with `TORI_CALLER` set ("attach from a terminal outside Tori"), so an agent is not handed a way to type into other tabs.
- `tori daemon` runs the daemon; `--uninstall` stops it and keeps it off ([[component_tori_daemon]]). A dev build refuses `--uninstall` and says how to stop its daemon.
- `tori` talks to the daemon, so it works with the window closed.
- Outside Tori, `tori` is on PATH only through Settings > Advanced > Terminal command (`shell_path.rs`): one line, marked `# added by Tori: the tori command`, in `~/.zprofile` (`~/.bash_profile` for a bash login shell) putting `<config>/run/bin` first. Remove takes out only marked lines.

## Related

- [[component_provenance]] what `--why` prints

- [[adr_review_submit_pins_the_reviewed_head]]: why `pr review` names a head
- [[component_app_socket]] - every method this calls
- [[component_tori_mcp]]: the MCP front, run as `tori mcp`
- [[adr_one_protocol_several_fronts]] - why the CLI is thin
- [[adr_socket_asks_the_webview_until_rust_owns_state]] - why `spawn`, `open`, `budget` and `ask` can time out naming the window
- [[gotcha_codex_shell_drops_env_names_containing_token_key_or_secret]] - why the caller token is `TORI_CALLER`
- [[concept_socket_event_vocabulary]] - what `tori events` prints
- [[component_autopilot_store]] - what `tori autopilot` reads and writes
- [[gotcha_the_debug_cli_reaches_tori_dev_not_the_installed_app]]: which app a debug build's CLI talks to
