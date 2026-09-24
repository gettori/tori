---
summary: emitting a result from Tauri's setup is lost since the webview has not loaded and events are never replayed
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (personal/tori, branch `chat`); Phases 3, 5; `src-tauri/src/chat/ownership.rs`
---

# Anything produced in Tauri's `setup` must be parked, not emitted

Do NOT `emit` a result computed during Tauri's `setup` and expect the frontend to receive it. `setup` completes before the webview loads, and Tauri does not replay events to late subscribers, so a `listen(...)` registered in a component's `onMount` is dead on arrival. This bit the chat orphan-reap listener, which looked correct and never fired once. Park the result in managed state and expose a command the frontend pulls once (`ownership::Orphans` + `chat_orphans`).

## Related

- [[gotcha_the_webview_is_not_a_hub_subscriber]]: the other way a Tauri event goes missing
