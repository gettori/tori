---
summary: one toggle group backs icon and swatch pickers so a hundred glyphs collapse to one tab stop, ArrowUp/Down move a row
status: current
updated: 2026-08-15
source: "plan \"Dedupe icon and swatch grids into one IconGrid\" (personal/tori, branch `109-dedupe-icon-and-swatch-grids`, issue #109, part of #93); `src/components/IconGrid/IconGrid.tsx`, `src/components/Dialogs/SpaceDialog.tsx`, `src/components/Dialogs/ProjectIconDialog.tsx`, `src/lib/toggle-group.ts`; commits cd09a5e, 8f86c77; PR #138"
---

# IconGrid: the one icon and swatch picker

**Location:** `src/components/IconGrid/`

The three selection surfaces the two icon dialogs used to hand-roll: `ProjectIconDialog`'s glyph grid, `SpaceDialog`'s glyph grid, and `SpaceDialog`'s colour row. One component on `@kobalte/core`'s toggle group, entering through `src/lib/toggle-group.ts` per [[component_lib_boundary]]. Two variants, `grid` (eight columns, scrollable, square glyph tiles) and `swatch` (one wrapped row of round tiles carrying their own hue). The colour row is the same control in a different shape, not a different control, which is why there is no separate `SwatchRow`.

The duplication was the ticket's stated reason; the tab stops were the worse defect. Every tile was its own stop across a set of 100+ glyphs, so a keyboard user could not get past the picker. The set is now one stop with a roving tabindex.

## Why the toggle group and not a radio group

#109 asked for radio semantics *and* for #100's characterization suites to keep passing. Both cannot hold. `RadioGroup` renders `role="radiogroup"` with `input[type=radio]` children carrying `aria-checked`, which kills every `getByRole("group", { name })`, every `querySelectorAll("button")` and every `aria-pressed` assertion in both suites. The toggle group renders `role="group"` with `button[aria-pressed]` children, byte-identical to the hand-rolled markup, and still delivers the roving tabindex the ticket actually wanted. Both suites passed with their existing cases untouched, which is what the migration was gated on. New cases were added; none were rewritten.

Same keyboard model as [[component_toggle_group]]: arrows and Home/End move focus without selecting, Space or Enter selects. The ticket's wording ("arrow keys move selection") was not followed deliberately, since selection-follows-focus across a hundred glyphs means a hundred selections on the way to the one you want.

## Four things the primitive does not give

**Always exactly one selected.** Kobalte's single mode reports `onChange(null)` when the pressed item is pressed again. Neither consumer has an empty state, so that change is dropped and the controlled value holds. "None" and "Automatic" are expressed as a **leading tile**, a value like any other, pinned first and exempt from the search filter because it is a state rather than a search result. Callers still speak `string | null`; the null maps to a `"__leading__"` sentinel inside the component.

**ArrowUp/ArrowDown move a whole row.** They are dead keys otherwise, see [[gotcha_a_kobalte_toggle_groups_arrowup_and_arrowdown_do_nothing]]. The handler sits on the **item** and calls `stopPropagation`, not on the group. A group-level handler would work today only because those vertical keys resolve to nothing: the group composes a caller's `onKeyDown` with its own through `composeEventHandlers`, which ignores `defaultPrevented`, so the day the primitive's orientation mismatch is fixed a group-level handler would move a row and then one tile more. Stopping at the item makes the behaviour owned rather than borrowed. The column count lives in one `COLUMNS` constant that both the handler and the inline `grid-template-columns` read; it is not a CSS custom property, because the token guard rejects a `var()` that resolves to nothing.

**The search field sits outside the group.** `IconGrid` owns it (it was duplicated verbatim in both dialogs, with a `ref` prop so `ProjectIconDialog` can still make it the dialog's `initialFocus`), but it renders as a sibling above `ToggleGroup.Root`, never inside it. Kobalte's keydown guard is containment in the group's element rather than "the target is an item", so an input inside would lose ArrowLeft/ArrowRight and Home/End to the roving focus and its caret would stop moving.

**The group keeps a tab stop when the query eats the focused tile.** See [[gotcha_a_toggle_group_whose_focused_item_unmounts_falls_out_of_the_tab_order]]. `IconGrid` mirrors the focused value from the same events the primitive uses, and computes `tabIndex` by the primitive's own rule against the tiles actually on screen. It wins because Kobalte spreads incoming props after its own.

## Enter changed, deliberately

Before this, Enter on a focused tile bubbled to the dialog, whose `onKeyDown` called `preventDefault()` and confirmed. That `preventDefault` cancelled the button's activation, so the dialog submitted and the tile was **not** selected: the grid had no keyboard activation at all. `IconGrid` stops both activation keys at the group, the same rule `SegmentedControl` settled, so Enter on a tile picks that tile and confirming needs focus outside the picker. Both dialog suites gained a case for it, since no existing test fired Enter anywhere but the search or name field.

## The tile is a toggle item and a tooltip trigger at once

A tile is icon-only, so its name has to be supplied and its tooltip is the only way a sighted user reads it. That control has to be *both* a `ToggleGroup.Item` (only the group's context can supply it) and a tooltip trigger, and `Button`'s trick of composing `Tooltip` from the inside is unavailable. `Tooltip`'s `as` was widened to take a component for this, with its props generic over that host, see [[concept_tooltip_trigger_is_the_control]]. The generic-to-concrete step that makes the typing sound lives in the lib door, see [[component_toggle_group]] and [[gotcha_a_generic_polymorphic_component_cannot_be_inferred_from]].

## What stayed behind

`ProjectIconDialog`'s two mode buttons (Automatic, Upload) are **not** tiles and did not move. Upload is an action that opens a native file picker, not a value, and the three shapes are one selection held by the dialog. So that picker passes no leading tile and its grid holds nothing selected whenever a mode is chosen, which is also the state where the group itself carries the tab stop. `.iconModes`/`.iconMode` and the `.iconMode.iconSelected` pairing stay in `Dialogs.module.css`; everything else the grids used was deleted from it.

`SpaceDialog` still owns what goes *inside* its leading tiles (`.iconNone`, `.swatchAuto`), since that is the dialog's content rather than the grid's chrome.

## Connections

- [[component_toggle_group]] — the primitive underneath, and the second door the tiles need
- [[component_lib_boundary]] — why Kobalte enters through one module
- [[concept_tooltip_trigger_is_the_control]] — why the tile *is* the trigger
- [[component_dialog]] — the shell all three surfaces sit in
- [[concept_axe_accessibility_gate]] — where both variants are judged
- [[component_storybook_workshop]] — Components/IconGrid: Default, Bare, Swatches
- [[concept_design_token_system]] — the guard that rejected the column-count custom property
- [[adr_headless_primitives]] — the decision this implements

## Related

- [[gotcha_a_kobalte_toggle_groups_arrowup_and_arrowdown_do_nothing]]
- [[gotcha_a_toggle_group_whose_focused_item_unmounts_falls_out_of_the_tab_order]]
- [[gotcha_a_generic_polymorphic_component_cannot_be_inferred_from]]
- [[gotcha_a_non_keyed_show_callback_read_once_at_mount_freezes_its_value]]
