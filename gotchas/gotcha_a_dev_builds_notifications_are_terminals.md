---
summary: a dev build sends notifications as com.apple.Terminal, so they show in dev while a bundle whose Tori setting is off shows none
status: current
updated: 2026-09-25
source: gettori/tori#218 on branch orchestrator, plan "Ticket refs that say where they are, and one way to navigate there", phase notification-click; src-tauri/src/presence.rs:81; tauri-plugin-notification 2.3.3 src/desktop.rs
---

# A dev build's notifications are Terminal's

An unbundled binary has no bundle identifier, so `NSUserNotification` needs one borrowed. Under `tauri dev` both the notification plugin and `notify_needs_you` call `set_application("com.apple.Terminal")`; a bundled Tori uses its own `com.gettori.tori`. `set_application` is a process-wide once: whichever sender calls it first wins for both.

**Symptom:** notifications show and clicks work in dev, and the bundled app shows nothing. macOS still accepts the notification, so the sender sees no error: a click wait simply never returns.

**Cause:** macOS keeps a separate entry for Tori under System Settings > Notifications, and on the machine this was found on it was switched off. Dev never touches that entry.

**How to tell:** a dev run proves the code and the click path. Only a bundle proves the app's own notification setting. A quick check outside Tori is a small binary that calls `mac_notification_sys::set_application` with either identifier and sends one notification with `wait_for_click(true)`.

In dev the notification also carries Terminal's name and icon, and its click may bring Terminal forward just before Tori takes focus.

## Related

- [[gotcha_the_notification_plugins_desktop_send_never_reports_a_click]]: the send this applies to
- [[component_presence]]: the notification surface
