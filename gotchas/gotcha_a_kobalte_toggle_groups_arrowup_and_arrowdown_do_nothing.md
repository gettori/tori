---
summary: Kobalte's ToggleGroup skips orientation on its collection, so ArrowUp and ArrowDown are dead in a horizontal group
status: current
updated: 2026-08-15
source: "plan \"Dedupe icon and swatch grids into one IconGrid\" (personal/sway, branch `109-dedupe-icon-and-swatch-grids`, issue #109); `src/components/IconGrid/IconGrid.tsx`; commit 8f86c77"
---

# A Kobalte toggle group's ArrowUp and ArrowDown do nothing

Do NOT assume a horizontal toggle group steps sideways on the vertical keys, or that it does anything at all with them. `ToggleGroup.Root` builds a `TabsKeyboardDelegate` with `orientation: "horizontal"` but passes `createSelectableCollection` **no** orientation, so that switch takes its own `"vertical"` default and routes ArrowUp/ArrowDown into the delegate's `getKeyAbove`/`getKeyBelow`, which a horizontal delegate answers with `undefined`. Left and Right are the only keys that move. In a strip nobody notices; in a grid that is visibly eight wide they are dead keys. If you add your own handler, put it on the **item** with `stopPropagation` rather than on the group: the group composes a caller's `onKeyDown` with its own through `composeEventHandlers`, which ignores `defaultPrevented`, so a group-level handler starts double-moving the day that mismatch is fixed. See [[component_icon_grid]].
