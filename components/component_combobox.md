---
summary: Combobox renders its listbox as a plain sibling with no Content or Portal, since the dialog around it owns dismissal
status: current
updated: 2026-08-16
source: "plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (personal/tori, branch `110-pickermodal-and-chatpicker`, issue #110, part of #93, PR #140); `src/components/Combobox/Combobox.tsx`, `Combobox.test.tsx`, `Combobox.stories.tsx`, `src/lib/combobox.ts`, `src/lib/combobox.test.tsx`; commits `bd86d48` (the seam), `3289a6e` (picker), `9d471b7` (palette)"
---

# Combobox (the one filter-and-pick surface)

**Location:** `src/components/Combobox/Combobox.tsx`, `Combobox.module.css`, `src/lib/combobox.ts`

A text filter over a list that is **already open**. Both of Tori's filter-and-pick surfaces render through it: [[component_picker_modal]]'s body and the [[component_command_palette]]'s input and results. Built on Kobalte's combobox through [[component_lib_boundary]], styled on [[concept_design_token_system]], per [[adr_headless_primitives]].

It is not a select with a search box. In a select the list is a popup the trigger opens; here the list **is** the surface, and it is inside something the caller already opened (a dialog panel). That one difference decides most of what follows.

## The inline recipe

`Root` (with a controlled `open`) wrapping `Control` > `Input`, and `Listbox` rendered as a **plain sibling**. No `Content`, no `Portal`.

`Combobox.Content` is a Popper plus a DismissableLayer plus a focus scope plus `createHideOutside` plus prevent-scroll. Every one of those is either wrong here or already owned by [[component_dialog]]: positioning a list that is not floating, a second dismissal layer inside a modal, a second focus scope, and an `aria-hidden` sweep over a tree the dialog has already swept. Composing it would have been five bugs, not one wrapper.

`src/lib/combobox.test.tsx` pins the seam itself: the listbox renders with no `Content`, `aria-controls` resolves, and nothing aria-hides the surroundings. A future Kobalte that requires `Content` fails there rather than three components up.

## `open` tracks the row count, and that is an accessibility decision

`open={hasRows()}` rather than `open` pinned true. `Combobox.Input` always carries `role="combobox"`, so a combobox claiming `aria-expanded="true"` while its `aria-controls` names nothing is a critical `aria-required-attr` violation. Collapsed-when-empty is both the accessible answer and the true one, and it keeps the surface on the right side of [[gotcha_an_emptied_listbox_is_worse_than_no_listbox]] rather than fighting it.

The cost is that withdrawing the list also withdraws Kobalte's own result-count announcement, which is gated on the open state. So the empty line is `role="status"`: without it, the one moment a filter has nothing to report is the one moment it reports nothing.

## The value is pinned empty, so a pick is an event

`value={null}` on `Root` (`Combobox.tsx:135`). Left uncontrolled, Kobalte treats a pick as a **selection toggle**: clicking the same row twice fires `onChange` with the value and then with `null` ([[gotcha_an_uncontrolled_kobalte_combobox_treats_a_repeat_pick_as_a_deselect]]). The palette's `?` signposts are picked repeatedly without the surface ever closing, so they would have gone dead on the second press.

Pinning it buys three things at once. Repeat picks work. `resetInputValue` never runs, so the filter box is never rewritten to the picked row's label. And "no visible row is ever `aria-selected`" becomes true by construction rather than by luck, which is what lets `data-highlighted` mean *active* without competing with it.

## The `Bridge`: the one sanctioned reach past props

An internal child inside `Root` that calls `useComboboxContext()` (`Combobox.tsx:216`). Two jobs, neither of which Kobalte exposes a prop for:

- **Writing the filter text.** Kobalte owns the input's value as a controllable signal with no external `value` source, so a controlled `query` prop has nowhere to land. There is no `inputValue` prop. Both consumers write their own box (the picker's clear button, the palette's `?` signposts), so the reach is absorbed once here and callers see a plain `query` string.
- **Seeding the active row.** Kobalte only ever highlights a row inside its own `open()`, and a combobox that is open from birth never calls it. Without seeding, nothing is highlighted until an arrow key is pressed, so typing "mai" and pressing Enter would commit nothing. Kobalte also clears the focused key on **every** keystroke, so the seed has to re-run after each re-filter, not just at mount.

Both behaviours have tests named after them, because the `Bridge` renders nothing and would otherwise read as dead code to whoever deletes it.

## Filtering and ranking stay the caller's

`defaultFilter={() => true}`. Kobalte's filter only filters, it never re-orders, and both consumers rank by `fuzzyScore`. So the caller receives `onQueryChange`, does its own matching and sorting, and hands back `options` already filtered and ranked. Re-filtering here would silently drop rows the caller scored and Kobalte cannot see.

## Flat or grouped, never mixed

`options` is `ComboboxOption[]` **or** `ComboboxGroup[]`, and the wrapper declares `optionGroupChildren` only for a grouped list. This is not a style preference: Kobalte reads that key off every top-level entry, so one bare option in a list that declares it throws on `undefined.filter` ([[gotcha_kobaltes_optiongroupchildren_is_all_or_nothing]]). A throw rather than a mis-render is the good version, and it is what makes a caller with a headed block and a bare tail name the tail too.

The wrapper also **rebuilds** the list rather than reconciling it when the headings change (`Combobox.tsx:99,190`), because Kobalte builds every section node with `key: ""` and renders the collection through `<Key by="key">`. See [[gotcha_kobalte_builds_every_listbox_section_with_an_empty_key]]. A flat list yields a constant signature there, so it never remounts.

## Chrome

- **`Control` is the field, `Input` is just the text.** The height, padding, background, border and radius live on `Control`, which is what lets a trailing affordance (the picker's clear button) sit *inside* the border. This is the split Kobalte's own part names imply.
- **The focus ring keys off `:has(.input:focus-visible)`, not `:focus-within`,** so pressing the clear button does not light it.
- **The list has no card chrome of its own.** Unlike `Select`'s popper it renders inside a surface the caller already painted, so a border and shadow here would draw a box inside a box.
- **`itemComponent` swaps the label part's layout, not its identity.** A caller-supplied row still renders inside `Primitive.ItemLabel` (it is what names the option in the accessibility tree), but the part gets `.itemRow`, a flex row, instead of `.itemLabel`, an ellipsised text run.
- **`white-space: nowrap` lives on the row**, so every piece inherits it. Without it the `text-overflow: ellipsis` below is inert and a long path wraps and grows the row.

## API

`options`, `query` + `onQueryChange` (controlled), `onSelect(value)`, `aria-label` (required, there is no `<label>`), `listLabel`, `emptyLabel`, `placeholder`, `class` (lands on `Control`), `inputRef`, and three that exist because one consumer needed them and none speculatively:

- `itemComponent` for rows that are more than a label (the palette's glyphs, secondary text and key chips).
- `trailing` for an affordance inside the field (the picker's clear button).
- `onKeyDown` for keys the caller answers first. The picker's create-on-Enter needs it: with nothing matching there is no row for Enter to commit, so the primitive does nothing and the caller decides whether an unmatched name is a new one.
- `onActiveChange` for a caller with a second commit path that must agree with the keyboard (the picker's Ok button), since the highlight now lives inside the primitive.

String in, string out: Kobalte traffics in the option object, the wrapper keeps the caller's API on `value` strings, the same shape [[component_select]] exposes.

## What `src/lib/combobox.ts` does not re-export

`Root, Control, Input, Listbox, Section, Item, ItemLabel`. Deliberately absent: `Content` and `Portal` (see above), `Trigger` and `Icon` (there is no trigger, the list is the surface), `ItemIndicator` (nothing is ever selected while open), `HiddenSelect` (no Tori combobox posts a form), `ItemDescription`, and `Label`/`Description`/`ErrorMessage` (labeling belongs to the call site). `useComboboxContext` is exported alongside for the `Bridge`.

## Connections

- Consumed by [[component_picker_modal]] and [[component_command_palette]]
- Rendered inside [[component_dialog]] in both cases, which is why it owns no dismissal, focus trap or scroll lock
- Enters through [[component_lib_boundary]], styled on [[concept_design_token_system]]
- Gated by [[concept_axe_accessibility_gate]], with `aria-valid-attr-value` off for the expanded scan only, per [[gotcha_axe_cannot_judge_a_dropdown_trigger_in_any_browser]]
- Sibling of [[component_select]], which is the pick-from-a-popup half of the same family
- Third surface still to migrate: Composer's completion menu, filed as issue #139

## Related

- [[lesson_characterize_the_contract_not_the_shape]] for how both consumers' suites were carried across
- [[lesson_a_declaration_goes_inert_when_its_parent_changes]] for what the palette's scroller did on the way
- [[gotcha_a_creatable_filter_picker_must_not_create_on_enter_while_rows_still_match]], the picker rule `onKeyDown` exists to serve
