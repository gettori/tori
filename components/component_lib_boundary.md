---
summary: src/lib is Tori's contact surface with kobalte/core; a test fails if the package name appears in text anywhere else
status: current
updated: 2026-08-22
source: "Design system foundation: src/lib boundary, Kobalte install, import guard (personal/tori, branch `94-design-system-foundation`, issue #94, part of #93); `src/lib/dialog.ts`, `src/lib/boundary.test.ts`; commit e90eba3; second module: plan \"Tooltip primitive and the `title=` sweep\" (branch `102-tooltip-primitive`, issue #102); `src/lib/tooltip.ts`; commit c996ca9; toggle group: plan \"SegmentedControl onto Kobalte ToggleGroup, absorb LayoutToggles\" (branch `108-segmented-control`, issue #108); `src/lib/toggle-group.ts`; select: plan \"Select wrapper and native select migration\" (branch `106-select`, issue #106); `src/lib/select.ts`; boolean controls: plan \"Checkbox, Switch and Slider wrappers and control migration\" (branch `107-checkbox-switch-slider`, issue #107); `src/lib/checkbox.ts`, `src/lib/switch.ts`, `src/lib/slider.ts`; commit 121f892; tabs: plan \"Tab and OverflowTabBar onto Kobalte Tabs\" (branch `111-tab-and-overflow-tab-bar`, issue #111); `src/lib/tabs.ts`; combobox: plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); `src/lib/combobox.ts`, `src/lib/combobox.test.tsx`; commit `bd86d48`; radio group: plan \"Answer AskUserQuestion inside the chat panel\" (phase 1, branch `chat-transcription`); `src/lib/radio-group.ts`; commit `6933de0`"
---

# `src/lib/`: the primitives boundary

The whole of Tori's contact surface with `@kobalte/core`. Every headless primitive the app uses enters through a file in this folder, and `boundary.test.ts` fails the suite if any source outside it so much as names the package. Established by #94 with the first export, deliberately not after it, per [[adr_headless_primitives]].

## What it owns

- **One re-export module per primitive.** `dialog.ts` (#98), `tooltip.ts` (#102), `menu.ts` (#103, two namespaces from one file, see [[component_menu]]; `Group` and `GroupLabel` joined both lists in #158, the first pair here admitted *because* neither is usable alone: `GroupLabel` throws outside its `Group` and a `Group` with no label names nothing), `popover.ts` (#104, `Root, Portal, Content` only - `Trigger` and `Anchor` deliberately absent, the one consumer runs anchored controlled mode, see [[component_popover]]), `toggle-group.ts` (#108, `Root, Item`, which is the whole primitive: unlike the popover there is nothing withheld, and both selection modes ride the one pair, `SegmentedControl` in single and `LayoutToggles` in `multiple`, see [[component_toggle_group]]) and `select.ts` (#106, eleven parts down to `Item`/`ItemLabel`/`ItemIndicator` and `Section`, with `HiddenSelect` absent since no Tori select posts a form or wants autofill, and `Label`/`Description`/`ErrorMessage` absent because labeling belongs to the call site, see [[component_select]]); `checkbox.ts`, `switch.ts` and `slider.ts` (#107, the boolean-control family, see [[component_boolean_controls]]); `tabs.ts` (#111, `Root, List, Trigger, Content`; `Indicator` withheld, since no Tori strip draws a sliding underline and it is the one part that measures its selected trigger on every resize, and `Content` is there for Settings alone - the three overflow strips render no panels, and Kobalte omits `aria-controls` entirely when no `Content` claims the value, so a panel-less strip is clean rather than dangling; see [[component_tab]]). `tooltip.ts` takes `Root, Trigger, Portal, Content` - `Arrow` is deliberately absent, since Tori's tooltips have none ([[concept_tooltip_trigger_is_the_control]]). `combobox.ts` (#110) takes `Root, Control, Input, Listbox, Section, Item, ItemLabel`, plus `useComboboxContext`, which no other module exports: the wrapper needs it to write the filter text, since Kobalte owns the input's value and exposes no prop for it (see [[component_combobox]]). `radio-group.ts` (the AskUserQuestion form, `Root, Label, Item, ItemInput, ItemControl, ItemIndicator, ItemLabel, ItemDescription`; `ItemDescription` is taken where `checkbox.ts` omits its `Description`, because a radio option's second line is part of the choice rather than a hint about it, see [[component_radio_group]]). Its multi-select counterpart adds **no** module: Kobalte 0.13.13 ships `checkbox` and no `checkbox-group`, so `components/CheckboxGroup/` is a Tori composition over the already-wrapped `<Checkbox>` and touches `@kobalte/core` nowhere.
- **The allow-list.** Each module names the parts Tori actually composes, not everything the package exports, so what the app depends on is readable from the file alone. `dialog.ts` takes `Root, Trigger, Portal, Overlay, Content, Title, Description, CloseButton`; the anchored and non-modal variants are absent until something needs them. Two exclusions are sharper than the rest, and both are "composing this is wrong" rather than "nothing uses it": `combobox.ts`'s `Content` (above) and `slider.ts`'s `Input`, which renders an `<input type="range">` carrying the `slider` role itself, so putting it inside the thumb nests one slider in another and axe fails it ([[gotcha_kobaltes_slider_input_nests_a_second_slider_role_inside_the_thumb]]). `combobox.ts` withholds `Content` for the parallel reason: it bundles a dismissal layer, a focus scope and an `aria-hidden` sweep, and both consumers render inside a `Dialog` that already owns all three, so composing it would mean two of each inside one modal. Every other absence in this folder is "nothing composes it"; those two would break the surface.
- **The import guard.** `boundary.test.ts:40` globs every `.ts`/`.tsx` under `src/`, excluding this folder, and asserts none contains `@kobalte/core`. Tests outside `lib/` are scanned like anything else. It matches on the file's **text**, not on its imports, so a test comment that merely names the package fails the suite ([[gotcha_the_src_lib_boundary_guard_reads_comments_not_just_imports]]).
- **A mounted smoke test** for the seam itself (`dialog.test.tsx`), which fails only when the toolchain stops rendering Kobalte at all, never for a reason belonging to a styled wrapper. `combobox.test.tsx` (#110) is the second, and it pins something narrower: that an always-open inline listbox still works **without** `Content`, so a future Kobalte that requires it fails at the seam rather than three components up.

## The namespace convention

Each module exports **one namespace object**, so consumers write `Dialog.Root` and never a bare `Root` (`src/lib/dialog.ts:35`).

This is the decision with the longest reach in #94, and it is not cosmetic. Kobalte names its parts `Root`, `Content`, `Title` identically across dialog, menu, select, popover and tabs, so bare re-exports collide the first time one wrapper composes two primitives, and read as anonymous at every call site besides. `Dialog.Root` says which primitive it is. Every later `lib/` module follows this shape.

## What it does not do

- **No styling.** Not a class, not a token, not a CSS Module. Visual identity is `src/components/`, on [[concept_design_token_system]].
- **No Tori API.** No `ControlSize`, no variants, no Tori prop names. Wrappers translate; `lib/` re-exports.
- **No app imports.** Panels and `App.tsx` import the styled component, never this folder. The guard does not yet enforce this half (it polices the Kobalte ban only), so it currently rests on review.
- **No wrapping of what stays native.** `Button`/`IconButton`, `Resizer`, the visual components and the app widgets never get a `lib/` module; that list is what keeps the program from becoming wrap-everything. `SegmentedControl` (#108, done), `Tab`, `Menu` and `Popover` do migrate, each on its own ticket, per the #95 amendment to [[adr_headless_primitives]]. Staying native is not the same as staying away from a primitive: `LayoutToggles` renders each of its Kobalte toggle items *as* an `IconButton`, so a stays-native control ends up carrying a primitive's behaviour without the primitives layer owning its identity.

## Prerequisite: the jsdom shim

No Kobalte overlay is testable without the root `clientWidth` shim in `src/test/domSetup.ts:39`. Kobalte's dialog pulls in `solid-prevent-scroll`, which writes an invalid `calc()` into a jsdom document and poisons `getComputedStyle` for the whole tree. See [[gotcha_kobaltes_scroll_lock_writes_invalid_css_into_jsdom]] — this blocks every dialog test in #98 to #101, not just the smoke test.

#107 added a second shim beside it: `setProperty` now drops a value jsdom cannot parse instead of throwing, which is what a browser does with an invalid declaration. Kobalte's slider needs it on its very first render ([[gotcha_kobaltes_slider_writes_calc_nan_before_its_thumb_ref_lands]]).

## Connections

- [[adr_headless_primitives]] - the decision this folder implements: Kobalte for behavior, `src/components/` for identity, a guard with the first export
- [[adr_premium_design_system]] - the visual identity the wrappers built on these parts must not disturb
- [[concept_design_token_system]] - what `src/components/` styles against, and what `lib/` deliberately knows nothing about
- [[component_button]] - the existing primitive family the wrappers join rather than replace
- [[lesson_split_identity_from_consumed_name]] - the earlier form of the same boundary move
- [[gotcha_kobaltes_scroll_lock_writes_invalid_css_into_jsdom]] - the jsdom prerequisite above
- [[gotcha_import_meta_glob_keys_are_normalized_against_the_importing_file]] - how the guard's own exclusion was wrong on its first run
- [[component_dialog]] - the first wrapper built on this seam (#98), and the shape every later one follows
- [[gotcha_kobaltes_closebutton_labels_itself_dismiss]] - resolved by #98 not rendering the part at all: no dialog in the app has a close (X) button, so the "Dismiss" name never reaches a user
- [[gotcha_kobaltes_dialog_never_sets_aria_modal]] - the second thing a wrapper has to supply itself
- [[gotcha_kobaltes_modal_close_restores_focus_to_a_trigger_you_may_not_have]] - and the third, which matters for every trigger-less dialog in this app
- [[gotcha_vitest_4_does_not_externalize_deps_so_a_deps_inline_entry_can_be_dead_weight]] - why Kobalte is *not* in `deps.inline`
- [[component_menu]] - the third module on this seam, and the first to re-export two primitives side by side, which is what forces the aliased imports in `menu.ts`
- [[component_boolean_controls]] - the checkbox/switch/slider family (#107), which ends the native `type="checkbox"` and `type="range"` in this app
- [[lesson_a_wrapper_default_restyles_its_call_sites]] - what those wrappers got wrong first, and why no test could see it
- [[component_select]] - the module that ends the native `<select>` in this app, and the first wrapper whose call sites all had to *drop* a class rather than keep one
- [[component_combobox]] - the module that ends the hand-rolled `role="listbox"` in this app. The Omnibox was on the stays-native list until #110 found that leaving it there meant consolidating one filter-and-pick surface out of two
- [[component_radio_group]] - the newest module, and the one whose multi-select counterpart deliberately adds no door at all
