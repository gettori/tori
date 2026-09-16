---
summary: hiding an unplaced popover with visibility or display drops it from the accessibility tree, use opacity instead
status: current
updated: 2026-07-31
source: branch `navigation`, Popover extraction; `src/components/Popover/Popover.tsx`; commit 1235880; see [[component_popover]]
---

# Hiding an unplaced popover with visibility drops it from the accessibility tree

Do not hide a not-yet-placed popover with `visibility: hidden` or `display: none`. Both remove it from the accessibility tree, so a screen reader loses it for as long as the eye does, and testing-library's `getByRole` stops finding it. Why: the element still has to lay out for a self-measuring surface to be measurable. Use `opacity: 0` plus `pointer-events: none`.
**Retired with #104:** the last self-measuring surface is gone; Kobalte's popper owns placement everywhere. The trap only returns if something hand-rolls a measuring surface again.
