---
summary: a chat child dying at once sends its fatal event through wrap before spawn inserts the entry, so map-gated teardown misses it
status: current
updated: 2026-09-23
source: gettori/tori#197 on branch orchestrator; commit 392d36b0; src-tauri/src/chat/host.rs (`ChatHost::spawn`, `wrap`, `Lifecycle`)
---

# A chat child's fatal event can arrive before spawn inserts its entry

Don't treat "the `ChatHost` session map entry was removed" as "this session ended". `spawn` calls `transport.start` before it inserts the entry, and a child that dies straight away sends its fatal event through `wrap` on the reader thread first. The removal then finds nothing, and the dead entry is inserted afterwards. Why: the map records what `spawn` finished, not what the child did.

The app socket's `started` and `ended` events are gated on `Lifecycle`'s own announced set for this reason. `started` fires before `start`, and `ended` fires once from whichever path gets there first: the fatal path, `close`, or a failed start. Still open: the dead entry and its claim stay until something calls `close`.

## Related

- [[component_chat_host]]: the host this lives in
- [[component_app_socket]]: the consumer of the lifecycle events
