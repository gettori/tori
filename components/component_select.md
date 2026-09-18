---
summary: replaces the native select, whose OS popover ignored every theme, with a string wrapper over Kobalte's object listbox
status: current
updated: 2026-08-15
source: "plan \"Select wrapper and native select migration\" (personal/tori, branch `106-select`, issue #106, part of #93); `src/components/Select/Select.tsx`, `src/lib/select.ts`"
---

# `Select`: the one picker

**Location:** `src/components/Select/` (key files: `Select.tsx`, `Select.module.css`, `Select.test.tsx`, `Select.stories.tsx`), `src/lib/select.ts`

Kobalte's listbox-behind-a-button behind Tori's chrome and Tori's API, and the end of the native `<select>` in this app. A native select renders the *OS* popover, which takes no CSS and so ignored the token theme completely: it was the last surface in the app that could not be themed at all. Six call sites moved onto this in #106, which was every one that remained.

This is for committing one value out of a fixed list. A surface whose rows carry actions is [[component_menu]]; a filterable picker is the Omnibox's business.

## Responsibilities

- **Owns the trigger and listbox chrome**, on tokens, in `Select.module.css`. The caller's `class` adds *layout* (width) and nothing else. Every one of the six call sites originally carried a class that was the native select's chrome, and passing those in painted a second field on top of the trigger; all six were dropped or reduced to layout during self-review.
- **Owns the string API.** `options`, `value: string`, `onChange(value: string)`, `size?: ControlSize`, `disabled`, `class`, `aria-label` / `aria-labelledby`, and a trigger `ref`.
- **Does not own its own name.** The trigger is a `<button>`, so there is no `for` to inherit; every consumer passes `aria-label` or points `aria-labelledby` at its visible label. See the settings gap below.
- **Does not resolve an unknown value.** A `value` naming no option renders empty, deliberately: only the call site knows what an absent value means. `AppearancePane` resolves a deleted theme id to `DEFAULT_THEME_ID` *before* this prop, which is the right place for it.
- **No multi-select, no filtering, no non-string values.** Out of scope in #106 and nothing has asked since.

## String in, string out, over an object contract

Kobalte's controlled `value`/`onChange` traffic in the option **object**, and object options require `optionValue` / `optionTextValue` / `optionDisabled`, with groups requiring `optionGroupChildren` plus a `sectionComponent`. Every Tori call site keys on a string, so the wrapper is a lookup layer over that: `flat()` flattens groups, `selected()` finds the owning option, and `onChange` unwraps back to `.value` (`Select.tsx:64`).

Both are `createMemo`, and that is load-bearing rather than tidy: `AppearancePane`'s list arrives from a folder watcher, so a normalization done once at setup would pin whatever themes existed at mount. A generic `<T>` API was considered and rejected, since it would cost every call site an `optionValue` mapping to buy a flexibility no consumer wants.

`disallowEmptySelection` is set and a `null` from `onChange` is dropped, so the caller's signal always names a real option.

## The recipe

Composition and starting values from solid-ui per [[adr_solid_ui_reference]], snapped to Tori's ramps, recorded here as token names so no future reader needs the reference:

- **Trigger:** the *field* family rather than Button's, because a select reads as something you set, not something you do. `--canvas-input` on `--border-default`, `--tori-radius-md`, height from `--control-height*` per size, `--tori-text-lg` (`--tori-text-md` at `xs`), and the brand focus ring (`--brand-default` border plus a 3px `--brand-ring`) on `:focus-visible` only.
- **Listbox:** restates [[component_menu]]'s `.content` so the two read as one family of transient surface: `--canvas-card`, `--tori-radius-xl`, `--shadow-md`, z-index 1000.
- **Item:** Menu's row minus the rich-row machinery. `data-highlighted` and `:hover` reach the same state, `data-disabled` mutes through `--fg-muted` rather than opacity (a role is theme-correct, an opacity is not), and the selected row's check is `--brand-default`, since selection belongs to the brand family per [[adr_premium_design_system]].
- **Gutter:** 4, a number and not a token, because Kobalte hands it to floating-ui where it never reaches CSS. Same value and same reason as Menu's `TRIGGER_GUTTER`.

## Key files & entry points

- `src/lib/select.ts:37` — the allow-list namespace. `HiddenSelect` is absent (no Tori select posts a form or wants autofill), as are `Label`/`Description`/`ErrorMessage` (labeling is the call site's) and `ItemDescription`.
- `src/components/Select/Select.tsx:64` — the string-to-option memos.
- `src/components/Select/Select.tsx:120` — portals into the enclosing dialog's panel when there is one, `document.body` otherwise; the same call `Dropdown` makes.
- `src/panels/Settings/paneKit.tsx:130` — `rowLabelId`, the id a settings control points `aria-labelledby` at.

## The six call sites

`ChatPane` (default surface, transcript density), `AppearancePane` (theme, the only grouped one), `MergeBar` (merge method, `xs`, disabled while busy), `DebugTargetDialog` (script, takes the focus `ref`), `Styleguide` (theme, `sm`). The issue's count of 8 was stale: `RuleList` no longer exists and the Chat `Picker` had already moved to `<Menu>` in #103.

## Connections

- Depends on [[component_lib_boundary]] — enters through `src/lib/select.ts`, like every other primitive
- Governed by [[adr_headless_primitives]] — behavior from Kobalte, identity from `src/components/`
- Governed by [[adr_solid_ui_reference]] — where the composition and the starting values came from
- Sibling of [[component_menu]], [[component_popover]], [[component_dialog]] — same seam, same split, and the listbox deliberately restates Menu's surface
- Used by [[component_settings_store]]'s panes, [[component_pull_requests_panel]], and the debug launch dialog ([[component_debug_launch]])

## Related

- [[concept_design_token_system]] — the ramps every value above is snapped to
- [[concept_axe_accessibility_gate]] — what gates the wrapper; the open-state scan turns off one rule it cannot judge
- [[gotcha_a_kobalte_select_closes_when_its_options_array_identity_changes]]
- [[gotcha_a_settings_row_label_is_a_sibling_so_its_control_has_no_name]]
- [[gotcha_axe_cannot_judge_a_dropdown_trigger_in_any_browser]] — the select's trigger draws the same review item
- [[lesson_an_added_test_file_can_fail_an_unrelated_one]] — what building this exposed in the suite
