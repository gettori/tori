---
summary: a throwaway probe sampled a modal stack one tick before Kobalte finished aria hiding and reported a problem as gone
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven simple dialogs onto Dialog\" (personal/tori, branch `99-migrate-seven-dialogs`, issue #99); `src/components/Dialogs/stackedDialogs.test.tsx`; commit `bfca5c2`"
---

# A probe that measures too early reports no problem

## What happened

Two modal dialogs open at once became reachable for the first time (`AskpassDialog` is mounted app-wide, so a backgrounded fetch can raise a credential prompt over an open confirm). The plan predicted axe would report `aria-hidden-focus` on the covered panel, and deliberately said to *measure* that rather than assert it.

A throwaway probe measured it: zero violations, zero incomplete, nothing to see. The conclusion drawn was that Kobalte's aria-hiding accounts for the layer underneath. That conclusion was stated out loud, and it was wrong. The probe awaited a macrotask; the real test awaits an animation frame. In the ~16ms between them Kobalte finishes aria-hiding, and axe then files `aria-hidden-focus` under `incomplete` because jsdom cannot decide whether buttons beneath an aria-hidden layer are reachable.

## Why

Kobalte does its modality work from its own deferred callbacks (see [[gotcha_kobalte_defers_its_outside_pointerdown_listener_and_its_unmount_auto_focus_to_a_settimeout_0]]). A probe is therefore sampling a UI mid-settle, and the mid-settle state is not a weaker version of the settled one: it is a *different* state, in which the thing being looked for does not exist yet. So the measurement comes back clean and reads as evidence of absence.

The trap is sharper than an ordinary flake because the probe agreed with the answer that required no further work. A measurement that says "the predicted problem is not there" retires the prediction, and nothing downstream re-opens it.

## What to do next time

Sample the state the user actually meets, which for anything with deferred setup means after it has settled, and prove the probe can see the thing before trusting it when it does not. Concretely:

- Match the probe's waiting to the real test's, not to whatever was quickest to type. If the test awaits a frame, the probe awaits a frame.
- When a probe contradicts a prediction, suspect the probe first. Establish that it *would* have reported the predicted result under some condition, otherwise "clean" is unfalsifiable.
- Write the timing into the test comment. The next reader needs to know that measuring one tick earlier shows a different, tidier, wrong answer.

## Related

- [[gotcha_two_stacked_modals_make_aria_hidden_focus_unjudgeable]] - what the settled state actually reports
- [[gotcha_kobalte_defers_its_outside_pointerdown_listener_and_its_unmount_auto_focus_to_a_settimeout_0]] - the deferral that opens the window
- [[concept_axe_accessibility_gate]] - why `incomplete` is a failure here rather than a pass
- [[lesson_debug_the_harness_before_recording_the_outcome]] - the same discipline one level up
- [[lesson_a_gate_that_cannot_fail_is_not_a_gate]] - the family this belongs to
- [[lesson_a_gate_only_sees_the_configuration_the_test_builds]] - the sibling failure on the coverage axis: #100 measured the right moment and the wrong configuration, twice
