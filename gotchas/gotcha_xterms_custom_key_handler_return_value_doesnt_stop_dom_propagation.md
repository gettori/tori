---
summary: attachCustomKeyEventHandler returning false only tells xterm to ignore the key, keydown still bubbles unless stopped
status: current
updated: 2026-07-19
source: "v0.1 features: status indicators, search, input layer (personal/sway, branch `topbar`); Phase 3; `src/panels/Terminal/TerminalView.tsx:177`"
---

# xterm's custom-key-handler return value doesn't stop DOM propagation

`term.attachCustomKeyEventHandler` returning `false` only tells *xterm itself* to ignore the key; the native `keydown` event keeps bubbling up to `window` unless you also call `e.stopPropagation()`. `e.preventDefault()` alone let a hotkey handled inside the terminal's custom handler ALSO fire a second time via `App.tsx`'s window-level `keydown` listener (e.g. Cmd+Shift+A skipped two waiting sessions instead of one). Call both, not just `preventDefault`.
