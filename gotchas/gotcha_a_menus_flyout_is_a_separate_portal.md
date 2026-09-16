---
summary: a submenu resolving its own portal mount drifts once a call site passes an explicit mount, so publish it instead
status: current
updated: 2026-08-15
source: Menu onto Kobalte DropdownMenu and ContextMenu, phase 5 self-review (personal/sway, branch `103-menu`); `src/components/Menu/surface.ts`, `src/components/Menu/Dropdown.test.tsx`; [[component_menu]]; commit `1827ba1`
---

# A menu's flyout is a separate portal

Do NOT let a submenu resolve its own portal mount. A menu is not one portal: every level is its own, and a part that reads `useDialogSurface()` for itself agrees with the menu it belongs to right up until a call site passes an explicit `mount`, at which point the rows sit where they were told and the levels under them sit in the body. The wrapper publishes its *resolved* mount through `src/components/Menu/surface.ts` and `MenuSub` reads that, so the mount stays one decision made once. A dialog cannot show the bug, because a dialog answers the same for both, so the guard passes an explicit element instead.
