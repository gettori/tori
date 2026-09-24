---
summary: an event published on a socket hub channel never reaches the webview; mirror it as a Tauri event if the UI needs it
status: current
updated: 2026-09-24
source: plan "Autopilot session and the cockpit (#205)" on branch orchestrator, issue gettori/tori#205; commit 669596a1; src-tauri/src/rpc/mod.rs (autopilot_publisher), src-tauri/src/rpc/runner.rs
---

# The webview is not a hub subscriber

Do NOT expect the UI to see an event just because it is published on the app socket's `Hub`. Only socket connections subscribe to channels, and the webview holds no socket connection. Why: the webview talks to Rust through Tauri commands and events, and the hub has no Tauri sink. Emit a Tauri event beside the hub publish, as `autopilot_publisher` does for `autopilot://changed` and the runner does for `autopilot://status`.

## Related

- [[component_app_socket]]
- [[component_autopilot_cockpit]]
- [[gotcha_anything_produced_in_tauris_setup_must_be_parked_not_emitted]]: the other way a Tauri event goes missing
