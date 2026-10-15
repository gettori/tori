---
summary: Tauri 2 calls both the tray's and the app's on_menu_event for every menu click, so two handlers see each click twice
status: current
updated: 2026-10-15
source: plan "Tray and menu bar improvements" phase tray-raises-window (branch `menu-options`); `src-tauri/src/app_menu.rs` `route`
---

# Every Tauri menu handler sees every menu event

Don't register a menu handler on the tray builder and another on the app expecting each to get its own clicks. Tauri 2.11 delivers every menu event, tray or menu bar, to every registered `on_menu_event`. Register one router (`app.on_menu_event` -> `app_menu::route`) and dispatch on the id's prefix. Why: Tauri keeps one global menu event channel and fans it out to every listener.

## Related

- [[component_app_menu]]: the router and its prefixes
