---
summary: tauri-plugin-notification's desktop show() never emits a click, so onAction is dead; send via mac-notification-sys to hear one
status: current
updated: 2026-09-25
source: gettori/tori#218 on branch orchestrator, plan "Ticket refs that say where they are, and one way to navigate there", phase notification-click; tauri-plugin-notification 2.3.3 src/desktop.rs; mac-notification-sys 0.6.15 objc/notify.m; src-tauri/src/presence.rs:81
---

# The notification plugin's desktop send never reports a click

`onAction` from `@tauri-apps/plugin-notification` compiles, registers and never fires on desktop. The plugin's desktop `show()` spawns `notify_rust::Notification::show()` and drops the handle, and nothing on that path emits `actionPerformed`, which only the mobile side sends. So a notification body click just activates the app, and any `extra` payload put on the notification is never read back.

**Symptom:** clicking a needs-you notification brings Tori forward and lands nowhere in particular, while the listener meant to route it sits registered and silent.

**Fix:** send from Rust with a click wait. `notify_needs_you` in `presence.rs` uses `mac_notification_sys::Notification::new()...wait_for_click(true).send()` on a spawned thread. On `NotificationResponse::Click` it brings the window forward and emits `nav://open` with the target.

**What it costs:** off the main thread, mac-notification-sys blocks on a condvar until the notification is clicked, dismissed, or found gone from Notification Center by a poll timer on the main run loop. That is one parked thread per notification the user has not acted on. This was read from the library's source, not measured. It is the deprecated `NSUserNotification` API, which still delivers on macOS 27; notify-rust's `preview-macos-un` feature is the `UNUserNotificationCenter` path, which needs a signed bundle.

Elsewhere than macOS the command falls back to the plugin, with no click.

## Related

- [[component_presence]]: where the notification is sent
- [[concept_in_app_navigation]]: where the click goes
- [[gotcha_a_dev_builds_notifications_are_terminals]]: why a dev run and a bundle can disagree on whether it shows at all
