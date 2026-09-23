---
summary: claude does not echo a user turn sent from outside the panel, so ChatHost::deliver draws the bubble unless the transport echoes (ACP)
status: current
updated: 2026-09-23
source: gettori/tori#198 on branch orchestrator; commit f66f5da7; src-tauri/src/chat/host.rs (deliver); src-tauri/src/chat/transport.rs (echoes_sent_turns)
---

# A turn sent from outside the panel draws no user bubble

The chat panel draws the user's bubble itself when it sends (`pushUserTurn`), and claude's stream does not echo that turn back. So a turn that arrives some other way, `tori steer` for one, runs with no bubble in the transcript: the reply appears under nothing. `ChatHost::deliver` publishes the user message itself for that reason, unless `AgentTransport::echoes_sent_turns()` is true. ACP returns true, since its agent republishes the prompt it was sent, and drawing it again would show it twice.

## Related

- [[component_chat_host]] - `deliver`
- [[component_app_socket]] - `session.steer`, the caller
- [[component_acp_transport]] - the transport that echoes
