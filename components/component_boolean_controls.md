---
summary: Switch is for a flip that is the action, Checkbox for an unconfirmed option, decided per site rather than by look
status: current
updated: 2026-08-15
source: "plan \"Checkbox, Switch and Slider wrappers and control migration\" (personal/tori, branch `107-checkbox-switch-slider`, issue #107, part of #93); commit 121f892 (wrappers); `src/components/Checkbox/Checkbox.tsx`, `src/components/Switch/Switch.tsx`, `src/components/Slider/Slider.tsx`"
---

# Checkbox, Switch and Slider

**Location:** `src/components/Checkbox/`, `src/components/Switch/`, `src/components/Slider/` (key files: `Checkbox.tsx`, `Switch.tsx`, `Slider.tsx`, and the `lib/` modules `checkbox.ts`, `switch.ts`, `slider.ts`)

The boolean-and-continuous control family: Kobalte's checkbox, switch and slider behind Tori's chrome and Tori's API. Built as one ticket because they share a shape (a hidden native input, a drawn control, an optional label) and because deciding *which* of them a given site should be is the interesting part. Ends the native `type="checkbox"` and `type="range"` in `src/`: 18 checkboxes and one range input migrated, leaving nothing but the wrappers' own doc comments.

## The semantic split (the part worth remembering)

Checkbox or Switch is a **semantic** choice, not a visual one, decided per site:

- **`Switch`** for a boolean whose flip *is* the action: every Settings toggle, plus the view filters in `SessionPanel` ("Show reads") and `CheckpointTimeline` ("workspace since here"). Nothing to confirm, so the control reads as a state.
- **`Checkbox`** for an option that scopes an action the user has not confirmed yet: the six dialog options, `AgentsSection`'s quarantine flag, and `ReviewPanel`'s `include untracked` and `Amend last commit`. The last two take effect instantly in the store yet stay checkboxes, because what they modify is the *pending commit*, and the box reads as "included in what I am about to do".
- **`Slider`** for a continuous value. One consumer, the Styleguide's ui-scale preview.

## Responsibilities

- **Own the drawn control**: the box and tick, the track and thumb, the fill, the focus ring, and the checked and disabled states, all on [[concept_design_token_system]] tokens and scaled with `--ui-scale`.
- **Own the accessible wiring**: `aria-describedby` is passed through to the native input (not the root), because the sr-only hints the panels keep have to be announced against the control itself.
- **Do NOT own the label's typography.** `color` and `font-size` are inherited. The control is the wrapper's; the words beside it belong to the caller's row, and those rows disagree deliberately (a dialog option is `--tori-text-lg`, a panel filter is muted and smaller). Hard-coding them was a real regression, see [[lesson_a_wrapper_default_restyles_its_call_sites]].
- **Do NOT own layout.** The caller's `class` adds it, the same chrome split [[component_popover]] documents.
- **Do NOT do multi-thumb ranges.** `Slider` unwraps Kobalte's `number[]` to a scalar at the wrapper rather than at every call site; a real range would get its own wrapper.

## Why the migration cost almost no test churn

Kobalte's checkbox and switch both render a **real `<input type="checkbox">`** (the switch adds `role="switch"`), so all 209 Settings tests passed with no edit at all: they query `input[type="checkbox"]` inside a labelled row, and that element still exists. Neither primitive has a Space handler, either. Space works purely by native input semantics, which is why the wrapper suites assert the element's type rather than firing a `keyDown` (jsdom does not synthesize the click a browser generates from Space, so a key test there would measure jsdom rather than the wrapper).

One selector changed in the whole migration: `ReviewPanel.test.tsx`'s amend helper did `getByLabelText(...).closest("label")` and then queried inside it. Kobalte's label is a *sibling* of the input rather than its parent, so `getByLabelText` now returns the input directly.

The slider is the exception to the family: its thumb is a focusable `<span role="slider">`, not a hidden input, so arrows are Kobalte's own handlers. Pointer dragging is untestable here (jsdom reports a zero-sized track, so every drag maps to the same value) and deliberately untested; the keyboard path exercises the same value pipeline. Home and End route through the root's handlers rather than the thumb's and do not fire from a `keyDown` on the thumb, so the clamp test drives the arrows to the boundary instead.

## Key files & entry points

- `src/components/Checkbox/Checkbox.tsx` — the drawn box, the lucide `Check` indicator (`forceMount`, hidden by CSS unless `data-checked`/`data-indeterminate`: Kobalte's mount-on-check runs through solid-presence, which throws on uncheck inside a Dialog under jsdom 30), the describedby pass-through
- `src/components/Switch/Switch.tsx` — same shape over the track and thumb
- `src/components/Slider/Slider.tsx` — scalar API over Kobalte's array; `onChange` fires continuously while the thumb moves, which is what makes the ui-scale live preview possible (`onChangeEnd` is deliberately not exposed)
- `src/lib/slider.ts:17` — why `Input` is not re-exported
- `src/test/domSetup.ts:47` — the CSS error-recovery shim the slider needs to mount in jsdom at all

## Connections

- Depends on [[component_lib_boundary]] — the three `lib/` modules these compose
- Governed by [[adr_headless_primitives]] — behaviour from Kobalte, identity in `src/components/`
- Styles against [[concept_design_token_system]] — every colour and dimension
- Sibling of [[component_button]] — the control family that stays native
- Shown in [[component_storybook_workshop]] — stories per wrapper, both themes

## Related

- [[lesson_a_wrapper_default_restyles_its_call_sites]] — the label typography regression this family caused and fixed
- [[gotcha_unchecking_a_kobalte_checkbox_inside_a_dialog_throws_under_jsdom_30]] — why the checkbox tick is always mounted
- [[gotcha_kobaltes_slider_writes_calc_nan_before_its_thumb_ref_lands]] — why the slider cannot mount in jsdom unshimmed
- [[gotcha_kobaltes_slider_input_nests_a_second_slider_role_inside_the_thumb]] — the part not to compose
- [[gotcha_a_settings_row_label_is_a_sibling_so_its_control_has_no_name]] — why the Settings rows pass `aria-label` rather than a visible label
