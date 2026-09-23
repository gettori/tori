---
summary: one JSON-RPC unix socket per Tori process: token auth first frame, per connection bounded queue, rpc.json for outsiders
status: current
updated: 2026-09-23
source: gettori/tori#197 on branch orchestrator; commit 392d36b0; src-tauri/src/rpc/{mod,frame,transport,auth,hub,server,methods}.rs; dev/rpc-probe.mjs
---

# App socket (Rust)

`src-tauri/src/rpc/` is the one protocol every front talks to: the `tori` CLI, the MCP server, and later a WebSocket for a phone. See [[adr_one_protocol_several_fronts]].

## Responsibility

It owns the wire (newline-delimited JSON-RPC 2.0, no batches), proving who a connection is, subscriptions, and the methods that read session state. It does **not** own session state. Methods read the same stores the sidebar and chat panel read (`SessionIndex`, the ownership `Registry`, `ChatHost`), and the only thing it pushes are events other modules hand it.

Layering, bottom up. Nothing above `transport.rs` sees a unix socket:

- `frame.rs`: `Request`, `Response`, `Notification`, `read_request` with a 256 KiB line cap. An over-long line closes the connection, because the rest of it is still in the stream. A malformed line gets a parse error and the connection stays open.
- `transport.rs`: `Transport` (accept, shutdown) and `Stream` (clone, read timeout, close). `UnixTransport` binds `$TMPDIR/tori-rpc-<pid>-<seq>/s` with `0700` permissions. The `seq` is there because tests start many servers in one process ([[gotcha_rust_tests_sharing_a_temp_path_keyed_only_on_process_id_race_each_other]]), and the length is checked against [[gotcha_darwin_caps_unix_socket_paths_at_104_bytes]]. A TCP or WebSocket listener is a second implementation here.
- `auth.rs`: `authenticate(first, &Credential) -> Result<Principal, AuthError>`, the one function a per device credential will replace. The first frame must be `auth {token}`. Anything else, or silence past 5 s, gets `-32001` and the connection closes.
- `hub.rs`: `Channel` (`sessions`, `session:<id>`, `autopilot`) and `Hub`. The type is called `Channel` rather than Topic because Topic already means a feature workspace here; on the wire it stays `topic`.
- `server.rs`: the dispatcher and the per-connection threads. One thread reads, and one writer thread drains a bounded queue that is the only thing writing the socket after auth.
- `methods.rs`: the `Backend` implementation behind `sessions.list` and `session.tail`.

## Interface

- `auth {token}`, `subscribe {topic}`, `unsubscribe {topic}`.
- `sessions.list {cwd?, live?, limit?}` (default 50). Rows are `SessionMeta` plus `live`, newest first. Live sessions the index hasn't seen yet (no transcript written) are built from the claim (agent) and `ChatHost::live_sessions` (cwd) and come first. A terminal tab's agent has no cwd.
- `session.tail {id, agent, limit?}` (default 50): the last events from `chat::commands::read_history`, the same read `chat_history` uses. Outputs are capped with `cap_output` directly, **not** through `ChatHost::cut_outputs`, which would push full outputs into a live session's 16-entry cache and evict the ones the panel holds.
- Notifications are `event {topic, data}`. Today only `sessions` publishes, with `{kind: "started", id, agent, cwd}` and `{kind: "ended", id}` from [[component_chat_host]].
- Discovery works two ways. A spawned child gets `TORI_SOCK` and `TORI_TOKEN` from `rpc::child_env()`, called in `transport::build_command` and `pty_spawn`, so every PTY shell gets them too, deliberately. Anything else reads `~/.config/tori/rpc.json` (`0600`), written with `credential::write_bridge` and removed at exit only if it still names this instance, the same rule as [[concept_askpass_bridge]]'s file. Env wins over the file.
- `lib.rs` starts it fail-soft beside askpass, sets the `ChatHost` publisher to `hub.publish`, and shuts it down last on exit.

## Why publish never blocks

`publish` runs on whatever thread noticed the event. For a chat session that's the agent's stdout reader in `ChatHost::wrap`, and for `close` it's app exit. A socket write there would hand a slow client's backpressure to the agent. So each connection gets a queue of 256 lines, `publish` uses `try_send`, and a full queue drops that connection and closes its socket. The client then sees a hang-up instead of silently missing events. Responses go through the same queue with a blocking send, which only stalls that client's own reader.

## Related

- [[adr_one_protocol_several_fronts]]: why there is one protocol and fronts are thin
- [[component_chat_host]]: the publisher of `sessions` events
- [[gotcha_a_chat_childs_fatal_event_can_arrive_before_spawn_inserts_its_entry]]: why lifecycle events are gated on their own set
- [[concept_askpass_bridge]]: the socket, token and bridge-file pattern this copies
- [[concept_transport_neutral_event_model]]: the `ChatEvent` a tail returns
