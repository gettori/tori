---
summary: a self measuring popover that paints before placement shows a wrong first frame, gate paint on a placed signal
status: current
updated: 2026-07-31
source: branch `navigation`, Popover extraction; `src/components/Popover/Popover.tsx`; commit 1235880; see [[component_popover]]
---

# A self-measuring popover must not paint before it is placed

Do not let an anchored surface render at its unclamped position and correct itself a frame later. Why: the first painted frame is visibly wrong, and worst for an end-aligned surface, whose initial guess is out by its entire width - the History panel landed ~310px off before this was fixed. Gate the paint on a `placed` signal set in the measuring `requestAnimationFrame`.
**Retired with #104:** the last self-measuring surface is gone; Kobalte's popper owns placement everywhere. The trap only returns if something hand-rolls a measuring surface again.
