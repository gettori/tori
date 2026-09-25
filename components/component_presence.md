---
summary: Rust's Presence owns the needs-you rising edge and attended, and drives the OS notification, tray and dock badge itself
status: current
updated: 2026-09-26
source: Adapter registry, pulse, presence, checkpoints (personal/tori, branch `topbar`); Phase 3; plan "Autopilot hard lock, release on stop, reconcile on start (#209)", commits 28f747ed, 32def50a, f29dfcbd; gettori/tori#218 phase notification-click; moved into Rust by gettori/tori#212, commit 21533ec4; `src-tauri/src/presence.rs`, `src-tauri/src/rpc/mod.rs` (Composer::present)
---

# Presence (OS notification, tray, dock badge)

`src-tauri/src/presence.rs` takes each session's display dot outside the window: an OS notification when a session first blocks, a menu-bar tray with counts and one entry per session, and a dock badge counting blocked sessions nobody has looked at. All three read one rising-edge tracker, so they cannot drift on what "just blocked" or "still needs you" means.

## Responsibility

- **`Presence`**, held by the socket's Composer ([[component_app_socket]]):
  - `step` folds one tick of dots in and returns the sessions that just crossed into needs-you. It fires on the rising edge, never again while a session stays blocked, and again after a genuine re-block. A fresh block is always unattended.
  - `attend` records the selection and window focus. A selected row in a focused window counts as attended.
  - `unattended` is what the badge counts and what `sessions.list` reports as `attended: false`.
  - `surface` says what the tray and badge should change to, and nothing when they already show it.
  - `attended` and the last dots are pruned to the live list.
- **When it runs.** `Composer::present` runs after every composition, so an edge is only ever a dot that changed. `rpc_attention` (async) records attention and queues a `present` on its own. The live list is the reported tab and chat facts, which are held while a tab or chat is alive, so a window reload fires no second notification.
- **The OS calls run outside the lock.** Building the tray's menu waits on the main thread, so the tray, badge and notification are applied after the presence lock is released ([[gotcha_a_sync_tauri_command_runs_on_the_main_thread_so_it_must_not_wait_on_a_lock_held_across_a_tray_call]]).
- **Notification.** It is suppressed while the window is focused and the session is the selected row, or is a chat whose tab is on screen. A chat mints its session id before any transcript exists, so selecting its tab usually resolves only as far as its branch, which is why the chat fact carries `visible`. It is also skipped for a worker whose spawner can relay the question: the spawning chat is live, or the autopilot is on (`relayed`, which reads the runner's state directly). The title is the chat fact's name, else the index's name or title, else the id, so a fresh chat with no transcript notifies with its name. The body names the project (`unit_home::project_name`).
- **The click.** `notify_needs_you` sends through `mac_notification_sys` rather than the plugin, whose desktop send never reports a click ([[gotcha_the_notification_plugins_desktop_send_never_reports_a_click]]). A click brings the window forward and emits `nav://open` ([[concept_in_app_navigation]]).
- **Tray.** The tooltip counts running and needs-you, and the menu lists every session with a dot, needs-you first with a stable sort. A menu click emits `tray://focus-session`. `build_tray` in `lib.rs`'s `.setup()` fails soft like [[component_askpass]]: log and carry on, no tray rather than no app.
- **The webview.** `src/utils/presence.ts` keeps only `notifyQuota`: a quota notification names an account, so there is no one place a click could land. The sidebar reports attention through `noteAttention`.

## Interface

- `rpc_attention(session, focused)`: the webview's selection and focus.
- `sessions.list` rows carry `attended`.
- `tray://focus-session`, `nav://open`: the events the webview answers.

## Related

- [[adr_rust_composes_the_dot_from_reported_facts]]: why one detector, in Rust
- [[concept_needs_you_floor]]: the signal presence reacts to
- [[component_chat_panel]]: the chat-side facts
- [[component_autopilot_runner]]: the autopilot whose workers stay quiet while it runs
- [[gotcha_a_dev_builds_notifications_are_terminals]]: why a notification can show in dev and not in a bundle
