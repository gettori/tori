---
summary: ChatHost::deliver echoes the user message, so one the panel already drew goes through chat_send, never deliver
status: current
updated: 2026-09-25
source: plan "Autopilot hard lock, release on stop, reconcile on start (#209)" on branch orchestrator, issue gettori/tori#209; commits 28f747ed, 32def50a, f29dfcbd
---

# deliver draws the user message itself

Don't route a message the chat panel already drew through `ChatHost::deliver`. `deliver` emits its own `UserMessage` for any transport that does not echo sent turns (`src-tauri/src/chat/host.rs`, `deliver`), so the panel would show it twice. Panel sends go through `chat_send`, or `chat_send_held` for a tab's held first prompt. Why: `deliver` is for messages from outside the panel (the socket, the watcher) that nothing else draws.

## Related

- [[component_chat_host]]: `deliver` and `send`
- [[component_autopilot_runner]]: why the held first prompt needed its own command
