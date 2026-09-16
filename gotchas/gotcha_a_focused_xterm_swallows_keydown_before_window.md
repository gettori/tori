---
summary: a focused terminal consumes keydown before window, so an overlay Esc handler must bind on the capture phase
status: current
updated: 2026-07-19
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/sway, branch `topbar`); Phase 4; `src/components/ShortcutSheet/ShortcutSheet.tsx:15`; commit 0a0a1d3"
---

# A focused xterm swallows keydown before `window`

Do NOT attach an overlay's Esc handler on the bubble phase. Why: when a terminal has DOM focus it consumes the keydown before it reaches `window`, so a bubble-phase listener never fires, and the overlay becomes undismissable from the single most common focus state in this app. Use the capture phase (`addEventListener("keydown", fn, true)`). This is the same root cause that forces `dispatchHotkey` to be called from inside `attachCustomKeyEventHandler` as well as from the window listener.
