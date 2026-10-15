---
summary: app_menu.rs builds the macOS menu bar from a spec of COMMANDS ids and routes every menu and tray click by id prefix
status: current
updated: 2026-10-15
source: plan "Tray and menu bar improvements" (branch `menu-options`), commits 3a70fbda, 2a2d8182, 3815bf4a, 6e230afc, 10660fb1; `src-tauri/src/app_menu.rs`, `src/utils/appMenu.ts`, `src/App.tsx` (`runFromMenu`)
---

# App menu (menu bar and the menu event router)

`src-tauri/src/app_menu.rs` owns the macOS menu bar and the single router every menu click goes through, the tray's included ([[gotcha_every_tauri_menu_handler_sees_every_menu_event]]).

## Responsibility

- **The router.** `route` dispatches on the id: `app-quit` closes the window so the quit question still asks, `session:<id>` focuses that session ([[component_presence]]), `tray:<item>` raises the window then runs the item, `menu:<item>` opens a Help link or emits `menu://command`.
- **The layout lives in the frontend.** `src/utils/appMenu.ts` lists File, Edit, View, Go, Session and Window as command ids plus system items and separators, and `App.tsx` sends it once through the async `set_app_menu`. Labels come from `COMMANDS`, so the menu, the palette and the Cmd+/ sheet cannot disagree ([[concept_command_registry]]). An id with no `run` throws, so a dead item cannot ship.
- **Rust frames it.** `build` puts the Tori menu first (About, Settings..., Check for Updates..., Services, Hide, a Quit that closes the window) and Help last. The Window submenu takes `WINDOW_SUBMENU_ID` so macOS lists windows under it. At startup, before the frontend speaks, it builds the same frame around system items only, since WKWebView's copy and paste need an Edit menu.
- **Accelerators only for `global` keys.** A native accelerator takes its key before the webview ([[gotcha_a_native_menu_accelerator_takes_its_key_before_the_webview]]), so an item shows a shortcut only when its command is `global` scope. `window` scope keys, `editor` scope keys (Save) and a global key a widget binds (Cmd+, in the agent picker) stay off the menu and keep working in place.
- **Refusals.** A click on a command whose `requires` is unmet toasts the palette's reason (`refusal` from the omnibox) instead of doing nothing.
- **Help links are fixed in Rust**, so the webview can never ask the router to open an arbitrary URL.

## Related

- [[concept_command_registry]]: the table the layout reads
- [[component_presence]]: the tray whose clicks this routes
- [[concept_in_app_navigation]]: the `nav://open` a session click ends in
