---
summary: Kobalte's layer stack sends an outside press only to the topmost layer, so a nested menu closes and the panel survives
status: current
updated: 2026-08-15
source: "plan \"Popover onto Kobalte Popover\" (personal/tori, branch `104-popover`, issue #104); `src/panels/Terminal/HistoryPanel.test.tsx`; see [[component_popover]]"
---

# An outside press dismisses only the topmost Kobalte layer

Do NOT hand-wire a `dismissable` flag (or an equivalent guard) to keep a surface alive while something nested is open, and do not assume Radix's close-everything semantics: Kobalte's layer stack delivers an outside press to the topmost layer only, so a nested menu closes and the panel under it survives for the next press, with no wiring at all. Measured, not assumed - the #104 plan predicted both layers close, and the pinning test failed against reality. Pinned in `HistoryPanel.test.tsx` ("gives up only the row menu to a press outside both, then itself").
