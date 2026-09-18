---
summary: RadioGroup passes Kobalte the empty string for no selection, never undefined, since undefined flips it uncontrolled
status: current
updated: 2026-08-22
source: plan "Answer AskUserQuestion inside the chat panel" (phase 1), branch `chat-transcription`; issue gettori/tori#109's rejection, reversed for new surface; commit `6933de0`
---

# RadioGroup and CheckboxGroup

**Location:** `src/lib/radio-group.ts`, `src/components/RadioGroup/`, `src/components/CheckboxGroup/`

One choice out of a small fixed set, all of them visible at once, and its multi-select counterpart. Built for an agent's question form ([[concept_inline_agent_question]]), which is the first surface in the app that needed either.

## Two families, one door

`RadioGroup` is Kobalte behind [[component_lib_boundary]]: `src/lib/radio-group.ts` re-exports `Root, Label, Item, ItemInput, ItemControl, ItemIndicator, ItemLabel, ItemDescription` as one namespace object.

`ItemDescription` is re-exported where `checkbox.ts` deliberately omits its `Description`, and the difference is real rather than drift: a checkbox's hint belongs to the one box and its call sites already own an sr-only span, while a radio option's second line is part of the choice and has to be announced with the option it describes.

`CheckboxGroup` is **not** a new door. Kobalte 0.13.13 ships `checkbox` and no `checkbox-group`, so this is a Tori composition over the already-wrapped `<Checkbox>`: the `role="group"`, its accessible name, and the value array. Nothing new touches `@kobalte/core`, so the stays-native list in [[adr_headless_primitives]] is unchanged, and this is group bookkeeping rather than a hand-rolled primitive.

## `null` is a real value, and it maps to the empty string

Both wrappers take "nothing chosen" as a first-class state, because an unanswered question is the common case and a group that arrived pre-selected would answer it for the user.

`RadioGroup` hands Kobalte the **empty string**, never `undefined`, and that is load bearing: Kobalte reads `value === undefined` as uncontrolled and starts keeping its own state, so a group handed `undefined` ticks the radio the user pressed even when the caller's value never moved. The empty string is a value like any other, so the group stays controlled and matches no option. The cost is that `""` cannot itself be an option value, which is why `RadioOption.value` is documented as non-empty. See [[gotcha_kobalte_treats_an_undefined_controlled_value_as_uncontrolled]].

## Radio or Select is a density choice

This is for a handful of options the reader should be able to compare side by side without opening anything, which is exactly what an agent's question is. A longer list, or one where the choice is routine enough not to deserve the space, is a [[component_select]].

## What the wrapper owns and what it does not

It owns the drawn control and the accessible wiring, and nothing else: not the label typography, not layout. The native inputs Kobalte renders are real `<input type="radio">`, so arrow keys move between them and `getByRole("radio")` finds them without any JS of Tori's; each input is visually hidden and stays in the accessibility tree, which is what keeps the label association and the focus ring honest.

Labeling is the call site's: pass `label` for a visible group label or `aria-label` when something already rendered names the group. One of the two is required in practice, because a group with no accessible name fails the axe gate ([[concept_axe_accessibility_gate]]).

## Watch out

- **A CSS override was removed rather than kept.** Top-aligning a checkbox against a wrapped label would have tied with `Checkbox.module.css`'s own `.root` at 0,1,0 on the same element, leaving the winner to CSS-module bundle order, which jsdom cannot test either way. Same family as [[gotcha_same_specificity_hover_and_active_declare_active_last]].
- Two tokens that do not exist and get reached for: there is no font-weight token (the repo writes `500`/`600` literally) and the full-round radius is `--tori-radius-pill`, not `-full`.
- The token gate reads test fixtures as styling. Options named Red and Blue fail `check-tokens.mjs` as CSS named colours; rename the fixture rather than growing the allowlist, because the gate cannot tell test data from a stylesheet and the colour names are always arbitrary.

## Related

- [[component_lib_boundary]] - the seam `radio-group.ts` joins
- [[adr_headless_primitives]] - the decision, and the 2026-08-22 amendment putting RadioGroup on the migrating list
- [[component_boolean_controls]] - the `<Checkbox>` this composes over
- [[component_select]] - the denser alternative for a longer list
- [[concept_inline_agent_question]] - the surface both were built for
