---
summary: one JSON-RPC unix socket per Tori process: per child caller tokens, state pushed from the webview, a webview bridge for actions
status: current
updated: 2026-09-23
source: gettori/tori#197 and #198 on branch orchestrator; commits 392d36b0, ae2bbe65, 15f6b615, f66f5da7, 9c01ba2a, 85430c9e; src-tauri/src/rpc/{mod,frame,transport,auth,hub,server,methods,states,bridge,asks,client}.rs; dev/rpc-probe.mjs; gettori/tori#199 commits 25551855, 3a04d580, 52615c71
---

# App socket (Rust)

`src-tauri/src/rpc/` is the one protocol every front talks to: the `tori` CLI, the MCP server, and later a WebSocket for a phone. See [[adr_one_protocol_several_fronts]].

## Responsibility

It owns the wire (newline-delimited JSON-RPC 2.0, no batches), proving who a connection is, subscriptions, and the methods that read session state. It does **not** own session state. Methods read the same stores the sidebar and chat panel read (`SessionIndex`, the ownership `Registry`, `ChatHost`), and the only thing it pushes are events other modules hand it.

Layering, bottom up. Nothing above `transport.rs` sees a unix socket:

- `frame.rs`: `Request`, `Response`, `Notification`, `read_request` with a 256 KiB line cap. An over-long line closes the connection, because the rest of it is still in the stream. A malformed line gets a parse error and the connection stays open.
- `transport.rs`: `Transport` (accept, shutdown) and `Stream` (clone, read timeout, close). `UnixTransport` binds `$TMPDIR/tori-rpc-<pid>-<seq>/s` with `0700` permissions. The `seq` is there because tests start many servers in one process ([[gotcha_rust_tests_sharing_a_temp_path_keyed_only_on_process_id_race_each_other]]), and the length is checked against [[gotcha_darwin_caps_unix_socket_paths_at_104_bytes]]. A TCP or WebSocket listener is a second implementation here.
- `auth.rs`: `authenticate(first, &Credential) -> Result<Principal, AuthError>`, the one function a per device credential will replace. The first frame must be `auth {token}`. Anything else, or silence past 5 s, gets `-32001` and the connection closes. The process token (the one in `rpc.json`) authenticates as `Principal::Local`. Every child Tori spawns gets its own token from `Children::mint`, which authenticates as `Principal::Session(Caller::Terminal(tab) | Caller::Chat(session))`, and the connection keeps that principal for its life. A PTY revokes its exact token on exit (a tab restarted under the same id must not lose the new one), a chat revokes by caller when `ChatHost` sees it end.
- `hub.rs`: `Channel` (`sessions`, `session:<id>`, `autopilot`) and `Hub`. The type is called `Channel` rather than Topic because Topic already means a feature workspace here; on the wire it stays `topic`.
- `server.rs`: the dispatcher and the per-connection threads. One thread reads, and one writer thread drains a bounded queue that is the only thing writing the socket after auth.
- `methods.rs`: the `Backend` implementation (`TauriBackend`). `identity(principal)` gives the caller's agent, account and cwd, which fill any param left out; a `Local` caller has none, and `or_callers` answers with an error naming the flag to pass.
- `states.rs`: `SessionStates`, the webview's last report of each live session: its state (`working`, `needs_you`, `idle`, `ended`), `source` (`chat` or `pty`), folder and PTY tab, plus the `background` set. `replace` turns a push into events, and keeps a session missing from it until the `alive` check says its child is gone ([[lesson_absence_from_a_whole_list_push_is_not_an_end]]).
- `events.rs`: the envelope (`session_event`, `Place`), `EndReason`, `TurnBy`, `project_of` and `same_folder`. See [[concept_socket_event_vocabulary]].
- `quotas.rs`: `Quotas`, the last windows per `(agent, profile)`, so `account.quota` goes out when one moves.
- `bridge.rs`: `Bridge`, the request/reply channel to the webview for what only it can answer. See below.
- `asks.rs`: `Asks`, the questions `tori ask` put up and their answers.
- `client.rs`: the blocking client the `tori` CLI uses ([[component_tori_cli]]).

## Interface

- `auth {token}`, `subscribe {topic}`, `unsubscribe {topic}`, `caller` (who this connection is, and its identity).
- `sessions.list {cwd?, live?, limit?}` (default 50). Rows are `SessionMeta` plus `live` and `state`, newest first, and `background: true` on a session spawned with it. Live sessions the index hasn't seen yet (no transcript written) come first. A session counts as live when a claim holds it or the webview reports it, since a PTY agent tab that started fresh holds no claim.
- `session.tail {id, agent?, limit?}` (default 50): the last events from `chat::commands::read_history`. Outputs are capped with `cap_output` directly, **not** through `ChatHost::cut_outputs`, which would push full outputs into a live session's 16-entry cache and evict the ones the panel holds.
- `session.steer {id, text}`: chat sessions only. Steers when the cached state is working or needs you, sends otherwise, through `ChatHost::deliver` ([[gotcha_a_turn_sent_from_outside_the_panel_draws_no_user_bubble]]).
- `worktree.new {branch, project?, from?}`, `checkpoints.list {id}`, `checkpoint.diff {id, turn}`, `checkpoint.revert {id, turn, force?}`. Turns are 1 based. A revert refuses (`-32002`) while another live session writes in the folder, unless forced.
- `session.spawn {agent?, account?, folder?, prompt?, attach?, new_worktree?, project?, from?, background?}`, `window.open {path, line?}`, `budget {id?, folder?}`, `ask.create {question, options?, timeout?}`, `ask.wait {id, timeout?}`.
- Notifications are `event {topic, data}`. Session events have a dotted `kind` and go on both `sessions` and `session:<id>` through `Hub::publish_session`; `account.quota` goes on `accounts`. The kinds, their fields and where each is noticed are in [[concept_socket_event_vocabulary]].
- `rpc_session_states` (async) takes `{id, state, source, folder, tab?}` and `rpc_quota` takes `{agent, profile, readings}`. Modules without Tauri state publish through `rpc::publish_checkpoint` and `rpc::publish_pr`, which read a process wide `(Hub, SessionStates)` and do nothing before the socket is up.
- Discovery works two ways. A spawned child gets `TORI_SOCK` and `TORI_CALLER` from `rpc::child_env(caller)`, called in `transport::build_command` and `pty_spawn`, and a `PATH` with the `bin/tori` link in front (`rpc::path_with_cli`). Not `TORI_TOKEN`: [[gotcha_codex_shell_drops_env_names_containing_token_key_or_secret]]. Anything else reads `~/.config/tori/rpc.json` (`0600`), written with `credential::write_bridge` and removed at exit only if it still names this instance, the same rule as [[concept_askpass_bridge]]'s file. Env wins over the file.
- `lib.rs` starts it fail-soft beside askpass, sets the `ChatHost` publisher to `hub.publish`, and shuts it down last on exit.

## State is pushed, actions are asked

The webview owns session status, spawning, the concurrent cap, quota readings and question cards today, so the socket gets them two ways ([[adr_socket_asks_the_webview_until_rust_owns_state]]):

- **State is pushed.** `sessionActivity` invokes `rpc_session_states` with the whole `{id, state}` list whenever a state moves. `SessionStates::replace` takes the whole list rather than a delta, so a session a reload lost comes back as `ended`, and publishes only what moved. `sessions.list` never waits on the webview.
- **Actions are asked.** `Bridge::request` emits `rpc://request {rid, method, params}` and blocks the connection's thread until `rpc_reply(rid, result | error)`, or 10 s, after which the call fails naming the window. A webview error comes back as `-32002`. On the webview side `utils/rpcBridge.ts` holds `handleRpc(method, fn)`; Terminal registers `session.spawn` and serves the bridge from its mount.
- **Spawn needs no focus.** The pane hosts every unit's tabs, and a chat tab that has a session id starts `live`, so a tab opened offscreen mounts `ChatView`, spawns, and sends its first turn from `markAutoSend`. The id comes back before the turn runs.
- **`budget`** reads spend (`chat::usage`) and budgets (`settings`) in Rust and asks the webview only for quota windows (`usage.windows`).
- **Asks live in Rust.** `ask.create` refuses anything but a chat caller, shows the card through `ask.show`, and waits. Ids are random, since reading an answer consumes it. The webview reloads open asks from `rpc_asks_pending` and answers with `rpc_ask_answer`, so a reload loses neither. `ChatView` reports `waitingForAnswer` while a card is open, which is what drives the dot and the notification. A chat ending forgets its asks through `rpc::revoke`.

## Why publish never blocks

`publish` runs on whatever thread noticed the event. For a chat session that's the agent's stdout reader in `ChatHost::wrap`, and for `close` it's app exit. A socket write there would hand a slow client's backpressure to the agent. So each connection gets a queue of 256 lines, `publish` uses `try_send`, and a full queue drops that connection and closes its socket. The client then sees a hang-up instead of silently missing events. Responses go through the same queue with a blocking send, which only stalls that client's own reader.

## Related

- [[adr_one_protocol_several_fronts]]: why there is one protocol and fronts are thin
- [[component_chat_host]]: the publisher of chat session events
- [[concept_socket_event_vocabulary]]: every event kind and where it comes from
- [[gotcha_a_chat_childs_fatal_event_can_arrive_before_spawn_inserts_its_entry]]: why lifecycle events are gated on their own set
- [[concept_askpass_bridge]]: the socket, token and bridge-file pattern this copies
- [[concept_transport_neutral_event_model]]: the `ChatEvent` a tail returns
- [[component_tori_cli]]: the first front
- [[adr_socket_asks_the_webview_until_rust_owns_state]]: why state is pushed and actions are asked
- [[gotcha_codex_shell_drops_env_names_containing_token_key_or_secret]]: why the env var is `TORI_CALLER`
- [[gotcha_a_turn_sent_from_outside_the_panel_draws_no_user_bubble]]: what `session.steer` has to draw itself
