---
summary: Glide is one fill behind a list's active row, moved by transform; the pointer glides it, keys snap it, it observes only while lit
status: current
updated: 2026-11-17
source: plan "Visual polish pass with a Storybook kitchen sink" (personal/tori, branch ui-rework), phases 7 to 9; src/components/Glide/Glide.tsx:24; src/components/Glide/Glide.test.tsx; commits f4022525, d1ecb6fd, 5238cc82
---

# Glide, the shared row highlight

`src/components/Glide/Glide.tsx` One absolutely positioned fill, the first child of a list, sitting behind whichever row is active and moving between rows instead of each row painting its own hover.

## Responsibility

- Owns the fill's position, size, visibility and whether a move animates. Rows drop their own `:hover` and `[data-highlighted]` fills; picked, selected, danger and done washes stay on the rows and paint over it.
- Does not own which row is active. A caller says that through `active` (a function from the list to a row) and, for pointer-only lists, `hover` (a selector).
- Does not own keyboard handling, focus or selection. Kobalte or the list keeps all of that.

## How it moves

- Placement is a `transform` from layout offsets (`offsetLeft`/`offsetTop` summed up the `offsetParent` chain), never `top`/`height` and never `getBoundingClientRect`, so a scale animation on the list (a menu opening at .95) does not skew it and a move is compositor-only.
- It glides (a transform transition at `--tori-duration-med`, `--tori-ease-out`) only when a real `pointermove` with non-zero movement happened in the last 100ms (`POINTER_MS`, line 6). Anything else snaps, so a held arrow key never trails the selection.
- Leaving every row starts an 80ms grace (`GAP_MS`, line 9) before it hides, so crossing a separator or a gap does not blink.
- It observes the list (one `ResizeObserver` plus a `MutationObserver` on `childList` and optional `attributes`) only while it shows, and coalesces every change into one rAF re-measure. Hidden, it observes nothing: a worktree switch starts with the pointer resting on the sidebar, see [[concept_switch_cost_anatomy]].
- It re-reads `active` on `focusin`/`focusout`, because menus and Select move DOM focus together with `data-highlighted`. A hovered row takes over only on real movement.

## Interface

- `<Glide active? hover? inset? attributes? />` as the list's first child. `optionAt(list, i)` (line 14) is the helper for `[role="option"]` lists.
- The list (the frame) needs `position: relative; isolation: isolate`, because the fill is `z-index: -1`.
- `--glide-radius` and `--glide-fill` restyle it per frame; the sidebar uses a fade-right gradient and no radius.
- `inset(row)` shortens the fill from the left (sidebar branch rows start at the rail). `attributes` adds attribute names to watch while lit (`data-expanded`, so a closing context menu releases its row).
- Nested lists: every Glide host joins a module-level `fillLists` set, and `ownRow` (line 52) drops a row whose nearest fill list is another one, so the tree's fill never lights a lane card's row.

## Wearers

- Composer `@`, `/` and stash lists, and both panes of the model palette.
- Menus through `MenuGlide` (`src/components/Menu/rows.tsx:126`): `[data-highlighted]` minus danger rows, else the `[data-expanded]` submenu parent. Select's content. The Combobox tracks Kobalte's virtual focus (`focusedKey()`), since its listbox never takes DOM focus.
- The sidebar tree, Home's Topic list and each group and lane card body, through `RowGlide` (`src/panels/LeftSidebar/SidebarRows.tsx:583`). Cards need their own fill because `--lane-card` is opaque and would cover the tree's.

## Related

- [[component_menu]]: the menu's highlight row in its recipe is this fill now.
- [[component_combobox]]: why its fill reads virtual focus.
- [[concept_one_shot_entrances]]: the same ticket's rule that state changes animate by transition.
- [[gotcha_a_rounded_row_highlight_has_nowhere_to_put_a_left_rail]]: the rail still draws over a hovered branch, at z-index 0 against the fill's -1.
- [[gotcha_vitest_stubs_css_imports_to_the_empty_string]]: why `Glide.test.tsx` checks the three movement rules and nothing visual.
