---
summary: an ACP load or replaying rewire sends the whole conversation through wrap before SessionStarted, so live observers must gate on it
status: current
updated: 2026-09-23
source: gettori/tori#199 on branch orchestrator; commit 3a04d580; src-tauri/src/chat/host.rs (Lifecycle::observe, expect_replay); src-tauri/src/chat/mirror.rs (expect_replay); AgentTransport::replay in src-tauri/src/chat/transport.rs
---

# An ACP load hands history back through the live sink

`ChatHost::wrap` sees every event a session emits, and for an ACP session that includes its past. `session/load` on resume, and `replay()` on a rewire after a webview reload, both stream the conversation through the same sink as live frames, and only then send `SessionStarted`. The `AgentTransport::replay` contract says so: whatever arrives before `SessionStarted` is the conversation.

So anything in `wrap` that treats an event as something happening now (announcing a turn, a question, a permission prompt) fires once per historical turn on every resume. Claude is unaffected in practice, since it sends `SessionStarted` before its first turn and never replays, which is why a claude-only test passes.

The fix is the mirror's rule. Mark the session as replaying when it is announced and again when a rewire asks for a replay (`Lifecycle::expect_replay`, beside `Mirror::expect_replay`), and let `SessionStarted` clear it. A test emits a `TurnStarted` before `SessionStarted` and checks nothing went out.

## Related

- [[concept_socket_event_vocabulary]] - the events this gate protects
- [[component_chat_host]] - `wrap` and `Lifecycle`
- [[component_acp_transport]] - where the load is sent
