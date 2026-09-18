---
summary: axe runs inside jsdom and fails on incomplete too, because jsdom's blind spots would otherwise report as a clean pass
status: current
updated: 2026-08-12
source: "plan \"axe-core harness in the jsdom vitest project\" (personal/tori, branch `97-axe-core`, issue #97, part of #93); `src/test/axe.ts`, `src/test/axe.test.tsx`, `src/test/axeUsage.test.ts`; commit 0010b81"
---

# The axe accessibility gate

Accessibility is asserted in the test suite the repo already has: `axe-core` 4.13 wrapped directly (`vitest-axe` has been abandoned at 0.1.0 since 2022) and run inside the existing `dom` vitest project, so `pnpm test` enforces it with no browser runner, no Playwright, and no third test stack. The design question was not how to call `axe.run`, it was how to stop a jsdom-hosted a11y gate from reporting green while looking at nothing, because jsdom has no paint, no layout, and (per [[gotcha_vitest_stubs_css_imports_to_the_empty_string]]) no CSS at all. Every non-obvious choice in `src/test/axe.ts` exists to close one such false-green path. It is a **floor, not a ceiling**: it proves the absence of the defects axe can see under jsdom, which is a strictly smaller set than "accessible".

## How it works

`src/test/axe.ts` exports two functions and one seam:

- `expectNoAxeViolations(scope, overrides?)` is the assertion. It fails when **either** `violations` or `incomplete` is non-empty.
- `runAxe(scope, overrides?)` returns `{violations, incomplete}` for tests that care which rule fired.
- `formatAxeFailure(violations, incomplete)` builds the message, split out so both branches are testable without hunting for markup that makes a given rule indeterminate.

Four mechanisms carry the weight:

1. **`incomplete` is a failure, not a pass.** axe returns four arrays, and `incomplete` (its own term: "review items") holds nodes it could neither pass nor fail. jsdom is exactly the environment that produces them. A helper asserting only on `violations` would report success for every rule that silently did not run. Measured, not assumed: `<div aria-hidden="true"><button>x</button></div>` yields `aria-hidden-focus` in `incomplete` and an empty `violations`.

2. **A measured, non-overridable disabled set.** `runOnly` is the `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` tags (`best-practice` excluded, so a failure is a defect and not a style opinion). Three rules in that set are disabled, each verified blind under jsdom 30 rather than assumed:
   - `color-contrast` lands in `incomplete`; there is no paint and no CSS to measure.
   - `link-in-text-block` never matches (`inapplicable`) even given a real inline link inside a paragraph; it is a `cat.color` rule.
   - `scrollable-region-focusable` never matches even given `overflow: auto` around overflowing content; scroll geometry does not exist.

   The disabled set is spread **after** caller overrides (`rules: { ...overrides.rules, ...JSDOM_BLIND_RULES }`), because axe's `rules` option can *enable* rules outside the `runOnly` filter, so a shallow merge would let any caller re-enable a banned rule. See [[gotcha_axes_rules_option_enables_rules_outside_the_runonly_tag_filter]].

3. **Two scopes.** Inline components pass `render`'s `container`; anything portalled passes `document.body`. A `<Portal>` is a *sibling* of the container, so the wrong scope audits an empty div and passes. See [[gotcha_a_portalled_component_is_not_inside_renders_container]].

4. **Queued runs and honest stack frames.** axe rejects a concurrent `run`, so calls are chained through a module-level promise. Failures are thrown with `Error.captureStackTrace` so vitest blames the assertion's line rather than the helper's, which is the one real advantage a custom matcher would have had.

`src/test/axeUsage.test.ts` closes the last path: an `import.meta.glob` `?raw` scan over every `*.test.tsx` asserting each `expectNoAxeViolations(` call is awaited, returned, or handed back from an arrow. The function throws asynchronously, so a forgotten `await` is a silent pass, and this repo has no linter to catch a floating promise.

## Why it's this way

Because the failure mode of a jsdom a11y gate is not a crash, it is a green tick. Every alternative considered lost to that:

- **Assert only on `violations`** (the obvious reading, and what `jest-axe`-style wrappers do): treats "axe could not tell" as "axe approved".
- **A custom vitest matcher**: needs `domSetup.ts` registration and matcher typings; its only real gain, caller-frame attribution, is one `captureStackTrace` call.
- **Disable nothing and tolerate `incomplete`**: makes the gate noise, and noise gets suppressed.
- **Assert on `Button`** as the copy-pattern: an isolated labeled `<button>` cannot trip a WCAG A/AA rule, so the example would have been a ritual with no failure mode. `SegmentedControl` carries it instead, with a negative twin. See [[lesson_a_gate_that_cannot_fail_is_not_a_gate]].

Contrast is deliberately **not** this gate's job, and the reason is not "axe cannot see it" alone: [[concept_contrast_gate]] already measures every role against its declared surface. The gap neither gate covers is *composition-level* contrast, a role painted on a surface it was never declared against. That is recorded, not solved.

The known blind set is documented in the file as *known*, not complete. Any other rule jsdom cannot judge announces itself as an `incomplete` failure, which is the whole point of failing on `incomplete`: the gate degrades loudly instead of quietly.

On first use the gate found real defects rather than confirming health, which is the argument for having it: #114 (`role="tab"` with no `tablist` parent in the Editor and Terminal strips), #115 (`nested-interactive`, a close button inside the tab button), #116 (accessible-name props documented as required but typed optional). It also demonstrated its own ceiling: `ConfirmDialog` and `ShortcutSheet` pass cleanly while having no `role="dialog"`, no `aria-modal`, and no title association, because no WCAG A/AA rule says "this div should have been a dialog". Closing that is [[adr_headless_primitives]]'s job.

## What the disabled set costs

The three disabled rules are not just three rules of missing coverage; each is a **shape of defect the suite can never report**, and one of them has already bitten. `scrollable-region-focusable` is the sharpest: an `overflow-y: auto` element with no focusable content and no `tabindex` is unscrollable by keyboard, and no run here can say so, because jsdom has no scroll geometry for the rule to match on. It is worst inside a modal, where the page behind is scroll-locked and there is nothing else to scroll.

#98's `Dialog` hit exactly that: its scrolling body was correct by every assertion in the suite and unreachable by keyboard. The fix was a `tabindex={0}` plus a **hand-written** test asserting it, since the axe assertion beside it is structurally incapable of failing on the same defect. The rule generalizes: when a component's design touches a disabled rule's territory (scroll regions, colour, links in text), the gate is not the floor there and something else has to be. See [[gotcha_a_tabindex_less_scroll_region_passes_every_axe_run_under_jsdom]] and [[component_dialog]].

## What a green run does not prove

The disabled set is the *known* ceiling. #100 found a second one that is not about jsdom at all, and it is the more dangerous of the two because nothing announces it.

**The gate sees the configuration the test builds, not the one the app ships.** `PickerModal` was recorded as clean, and it was, for the picker its own test file constructs: every assertion passed a `placeholder` because a test needs a handle to type into. `askPick` passes none, and a placeholder was the only thing naming the filter field, so the app's picker had an unnamed input and a green gate for as long as the component existed. The same shape hit `SpaceDialog` from a different angle: the baseline was probed in new mode only, and a critical `label` violation lived in edit mode.

Note which direction the error runs. A fixture is usually a *richer* configuration than the caller's, so its extra props tend to satisfy rules rather than trip them. That makes this failure silent by construction and asymmetric: a gate measured this way is systematically too optimistic. Two defences, both cheap: enumerate the call sites and compare their props against the fixture's, and render every branch a component has rather than the one that needs least setup. `PickerModal.test.tsx` now carries an assertion named "as the callers actually render it" for exactly this. See [[lesson_a_gate_only_sees_the_configuration_the_test_builds]] and [[gotcha_axe_accepts_a_placeholder_as_an_accessible_name]].

As of #100 all fourteen dialogs gate on axe, and no rule override survives in the dialog cluster except `aria-hidden-focus` in the stacked case, which is a jsdom limitation rather than a deferred fix.

## Related

- [[adr_headless_primitives]] — the Kobalte-behind-`src/lib` decision this gate was built to serve; #97 is a child of #93.
- [[component_dialog]] — the first wrapper the gate ran against, and where the disabled set's cost showed up. It also closes this page's own ceiling note: `ConfirmDialog` and `ShortcutSheet` passing without being dialogs at all is what #98 to #101 fix.
- [[lesson_a_gate_that_cannot_fail_is_not_a_gate]] — the discipline that shaped the spike, the example, and the await scan.
- [[lesson_a_gate_only_sees_the_configuration_the_test_builds]] — the second ceiling, and the one nothing announces.
- [[component_picker_modal]] — where that ceiling was found, and the assertion added to close it.
- [[lesson_a_rule_that_matches_nothing_passes_every_guard]] — the same inert-guard shape one layer down, in CSS selectors.
- [[concept_contrast_gate]] — the other half of "measured, not reviewed", and what this gate deliberately leaves to it.
- [[component_overflow_tab_bar]] — where the gate's first findings landed.
- [[component_button]] — already DEV-warns on a missing accessible name, the runtime sibling of this static gate.
- [[gotcha_vitest_stubs_css_imports_to_the_empty_string]] — why there is no CSS under jsdom, hence no contrast to judge.
- [[component_storybook_workshop]] - the browser-side sibling. Its a11y panel runs the same axe against a real paint, so the three rules disabled here (`color-contrast` above all) actually execute there. It is a look-at-it surface, not a gate: nothing fails a build, which is why this jsdom floor still carries the enforcement.

## The three defects it found on the tab strip are closed (2026-08-16)

The first survey filed `aria-required-parent` and `aria-hidden-focus` against
[[component_overflow_tab_bar]] and `nested-interactive` against [[component_tab]]
(#114, #132, #115). All three were named and disabled at one scan rather than
swept into a green run, which is what kept them findable; #111 fixed them and
deleted the two disabled rules, so that scan now passes with only
`aria-valid-attr-value` off - the one every Kobalte trigger trips.

Worth noting how one of them was settled. The close button had three candidate
shapes and each looked right on paper; mounting all three and running this gate
over them took minutes and ruled out two, including the discovery that axe reads
straight through a `role="presentation"` wrapper to the element underneath. See
[[lesson_a_tablist_may_own_nothing_but_tabs]].

The gate does not cover Storybook. Stories carry no scan of their own, so a
story's shape is only guarded if a component test mounts the same shape; #111
added two such scans (a pill carrying every slot, and an overflowing strip with a
trailing action) for exactly that reason.
