---
summary: the fuzzy single select dialog behind attach branch, where Enter accepts a match but only Ok creates a typed name
status: current
updated: 2026-08-16
source: "Searchable fuzzy branch picker + creatable Add Branch/Add Worktree (personal/tori, branch `code-mirror-6`); rewritten by plan \"Migrate the seven complex dialogs onto Dialog\" (branch `100-migrate-seven-conplex-dialogs`, issue #100, PR #125); `src/components/Dialogs/PickerModal.tsx`, `PickerModal.test.tsx`, `PickerModal.stories.tsx`; commit `97a1eb6`; body moved onto the shared surface by plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); commit `3289a6e`"
---

# Picker modal (filterable single-select)

**Location:** `src/components/Dialogs/PickerModal.tsx`, `src/utils/fuzzy.ts` (wired through `askPick` in `src/panels/LeftSidebar/LeftSidebar.tsx`)

A fuzzy-filterable modal for choosing one item from a potentially large list (its first use: attach one of 100s of local branches, replacing a comma-joined prompt title). It composes [[component_dialog]] for the shell and [[component_combobox]] for the body, and is the select-from-list sibling of the freeform text prompt `PromptModal`. Ranking uses the same `fuzzyScore` matcher as the Omnibox's file mode, so both consume one implementation.

It is the only dialog in the #99/#100 wave whose **body changed rather than moved**, because the body was the accessibility problem.

## Responsibilities

- Take a `string[]` and let the user pick exactly one: type to fuzzy-filter + rank, up/down (wrap-around) to move the selection, click a row to commit it, Esc or a press outside to cancel.
- **Creatable mode** (opt-in `creatable`): a **Cancel / Ok** action row lets the same dialog both attach a listed item and create a new one (the create affordance is Ok, since a typed name has no row to click). The split that avoids accidental creation: **Enter** accepts the highlighted suggestion whenever the filtered list is non-empty, creating the typed name only when nothing matches; the **Ok** button commits exactly what's typed (an exact list match selects it, else a non-empty query is a new value). Without `creatable` the modal is select-only. See [[gotcha_a_creatable_filter_picker_must_not_create_on_enter_while_rows_still_match]].
- Keep the selected row visible via `scrollIntoView({ block: "nearest" })` (net-new; `QuickOpen` does not do this).
- Provide a clearable filter: an in-input clear button that resets the query **and refocuses the input** so keyboard nav keeps working.
- Does **not** own any data/fetching, validation, or the attach/create action itself: callers pass `items` and act on the resolved value (a value absent from the caller's routing map is a new name to create).

## The body is the shared surface now (#110)

`PickerModal.tsx` went from 196 lines to 141. The filter, the `role="listbox"`, `aria-activedescendant`, the arrow keys, the scroll-into-view and the ids all belong to [[component_combobox]]. What is left is the two things that are actually this dialog's own: **how it ranks** (`fuzzyScore`, since the shared surface never re-orders what it is given) and **what Ok means**.

**26 of the 30 characterization cases passed untouched**, which is the real result of the migration. Two of the four that moved were axe scans; the other two were an event name and one genuine shape change.

- **`aria-selected` now means the committed value.** The active row is `data-highlighted` plus `aria-activedescendant`. This picker commits and closes, so no visible row is ever selected. The old markup conflated active and selected because it had only one way to say "this row".
- **Nothing is left unhighlighted on mount.** Kobalte only seeds a highlight inside its own `open()`, which a list that is open from birth never calls, so the wrapper's `Bridge` seeds the first selectable row and re-seeds after each re-filter. This is what preserved the top-match-live model the picker has always had, and with it the three cases that would otherwise have had to be rewritten.
- **`fireEvent.mouseEnter` no longer moves the highlight.** Kobalte drives hover-focus from `pointerMove` and ignores any pointer that is not a mouse. Behaviour is intact; a touch drag no longer drags the highlight, which is an accepted regression.
- **Three props exist on the wrapper because this consumer needed them:** `trailing` (the clear button, inside the field), `onKeyDown` (create-on-Enter, the one case the surface cannot answer since with nothing matching there is no row to commit) and `onActiveChange` (Ok has to commit the same row Enter would, and the highlight now lives inside the primitive).

The list semantics #100 established are unchanged in substance and are now the shared surface's to keep: focus never leaves the filter field, the listbox is **withdrawn rather than emptied** ([[gotcha_an_emptied_listbox_is_worse_than_no_listbox]]), and the field has a real accessible name (`aria-label`, the caller's `placeholder` where there is one, else "Filter"). It had none in the app before, and the gate never noticed, which is its own lesson: [[lesson_a_gate_only_sees_the_configuration_the_test_builds]]. The static ids (`picker-list`, `picker-option-N`) are **deleted**; the primitive owns them.

## Scroll geometry

Unchanged in shape from #100 and now shared: `Dialog`'s body is the bounded, focusable scroller, and the field is `position: sticky; top: 0` inside it. The panel is `Dialog`'s default `confirm` size, i.e. the 420px it always had.

**Accepted visual deltas from #110**, none of them asked for by name: the active row is `--neutral-hover` rather than `--brand-subtle`, the list lost its own border and top margin, and the clear button sits in the field's flex row instead of being absolutely positioned over it. All three are the shared surface's chrome replacing per-call-site chrome, which is what the ticket was for. One cosmetic consequence: the sticky field is rounded, so a row can show a few pixels through its corners as it scrolls under, where the old square wrap hid them.

## Key files & entry points

- `src/utils/fuzzy.ts` - `fuzzyScore(query, target)`: subsequence match, `null` if not a subsequence, else higher = better (contiguity bonus + `/`-basename bonus). Shared with the Omnibox.
- `src/components/Dialogs/PickerModal.tsx` - the component; props `title`, `items`, `placeholder?`, `creatable?`, `okLabel?`, `onSubmit(value)`, `onCancel()`. Since #110 the Enter half arrives through the surface's `onSelect`, and what remains here is `commitTyped` (Ok / create) plus the one `onKeyDown` case where nothing matched.
- `src/panels/LeftSidebar/LeftSidebar.tsx:401` - `askPick(title, items, creatable?)` + `pickReq` signal + `resolvePick()`, mirroring the `askText`/`promptReq` plumbing; rendered in a `<Show when={pickReq()}>`. **Passes no `placeholder`**, which is the fact the axe baseline missed for as long as the component existed.
- `PickerModal.stories.tsx` - four stories under `Dialogs/`, including a 200-item list for the sticky filter and an empty one for the withdrawn listbox.

## Connections

- Composes [[component_dialog]] for the shell (#100) and [[component_combobox]] for the body (#110)
- Used by [[component_project_discovery]] - `addBranch` picks/creates a branch to attach via `askPick`; `addWorktree` (see [[component_worktree_lifecycle]]) picks/creates a worktree
- Sibling of `PromptModal` (freeform text), which migrated in #99
- Governed by [[adr_attached_branch_model]] - attach/create is the flow it serves
- Gated by [[concept_axe_accessibility_gate]] - including one assertion that renders it the way the callers actually do

## Related

- [[component_command_palette]] - the other consumer of the shared `fuzzyScore`, and since #110 the other consumer of the same surface. The two had mirrored each other's arrow/Enter/Esc + mouse-highlight pattern by hand for as long as both existed.
- [[gotcha_a_creatable_filter_picker_must_not_create_on_enter_while_rows_still_match]] - why Enter and Ok differ.
- [[gotcha_an_emptied_listbox_is_worse_than_no_listbox]] - the trap the empty result set walks into.
- [[lesson_characterize_the_contract_not_the_shape]] - how its shape block was rewritten to ask the accessibility tree the questions it used to ask a CSS class.
