---
summary: a Kobalte toggle group never clears focusedKey when its item unmounts, so every item reads tabIndex -1 and Tab loses it
status: current
updated: 2026-08-15
source: "plan \"Dedupe icon and swatch grids into one IconGrid\" (personal/sway, branch `109-dedupe-icon-and-swatch-grids`, issue #109); `src/components/IconGrid/IconGrid.tsx`; commit 8f86c77"
---

# A toggle group whose focused item unmounts falls out of the tab order

Do NOT let a filtered collection drop the item that currently has the roving focus without taking the tab stop back. Kobalte parks it on the focused item and takes it off the container: `tabIndex` is `focusedKey == null ? 0 : -1` on the group and `key === focusedKey ? 0 : -1` on each item, and **nothing clears `focusedKey` when that item unmounts**. Focus a tile, then type a query that filters it away, and every item reads -1 while the container reads -1 too, so the whole group is unreachable by Tab. The recovery in `onFocusIn` only runs when `focusedKey` is already null, so it never fires. Mirror the focused value from the same events the primitive uses and compute `tabIndex` by its own rule against the items actually rendered; an incoming prop wins, since Kobalte spreads props after its own. See [[component_icon_grid]].
