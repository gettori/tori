---
summary: keeping an overflowed active tab visible via onReorder turns a window resize into a permanent unrequested reorder
status: current
updated: 2026-06-29
source: Overflow-tab-bar (personal/sway); `src/components/OverflowTabBar.tsx` (`displayOrder`)
---

# Active-always-visible must not mutate the canonical tab order

Do NOT keep an overflowed-but-active tab visible by reordering the canonical list; do it as a display-only transform. Why: an effect that calls `onReorder` whenever the active tab falls into overflow turns a window/pane RESIZE into a permanent, unrequested reorder of the user's tabs (and can re-trigger when the active tab is wide enough to change the fit count). `OverflowTabBar` instead derives a `displayOrder` memo that pulls the active tab into the last visible slot for rendering only; only an explicit overflow-dropdown click persists a reorder.
