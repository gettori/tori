---
summary: a menu item's native accelerator fires before WKWebView sees the key and swallows it, wherever focus is
status: current
updated: 2026-10-15
source: plan "Tray and menu bar improvements" phase menu-key-spike (branch `menu-options`); `src/utils/appMenu.ts` `accelerator()`
---

# A native menu accelerator takes its key before the webview

Don't give a menu item an accelerator for a key anything in the webview also binds. On macOS the menu's key equivalent runs first and consumes the press, so CodeMirror, xterm and the composer never see it: with throwaway items on Cmd+/, Cmd+F, Cmd+B and Cmd+K, every press reached only the menu (no comment toggle, no terminal search, no sidebar, no palette). Why: it is not a double fire, it is a theft, so the safe set is exactly the keys that already fire everywhere, the `global` scope ones.

## Related

- [[component_app_menu]]: where the rule is applied
- [[gotcha_an_app_global_hotkey_must_yield_to_a_defaultprevented_key]]: the webview-side half of key ownership
- [[gotcha_a_focused_xterm_swallows_keydown_before_window]]: why `global` keys were already routed past the terminal
