---
summary: an axe baseline covers only the props and mode the fixture renders, and a fixture is usually richer than the caller
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven complex dialogs onto Dialog\" (personal/sway, branch `100-migrate-seven-conplex-dialogs`, issue #100, part of #93); `src/components/Dialogs/SpaceDialog.test.tsx`, `PickerModal.test.tsx`; PR #125"
---

# A gate only sees the configuration the test builds

## What happened

Seven dialogs got an axe assertion each, and the plan deliberately **measured** the current markup before writing any of them, so a pre-existing violation could not be mistaken for the migration's fault. The measurement was careful and it was still wrong twice, in the same way.

**`SpaceDialog`, one mode of two.** The first probe rendered new mode, reported clean, and that was recorded as the dialog's baseline. New mode's name field carries `placeholder="space name"`; edit mode swaps it for a disabled, readonly field with no placeholder and no label, which axe files as `label`, critical. The violation existed the whole time in a mode the probe never rendered.

**`PickerModal`, a configuration no caller produces.** Phase 1 recorded zero violations, and every assertion in the file passed `placeholder="Filter branches"` because a test needs a handle to type into. `askPick` (`LeftSidebar.tsx:401`) takes a title, items and `creatable`, and passes **no placeholder at all**. Strip it and `label` fires, critical. So the recorded green was true of the picker the test built and false of the one the app ships, and it had been true for as long as the component existed.

Neither was caught by the gate. The first was caught by a later test that happened to render both modes; the second by a self-review question about which callers actually pass which props.

## Why

A test does not sample a component, it *constructs* one. Every prop the fixture supplies is a choice, and the defaults a test picks are chosen for the test's convenience: something to type into, something with a visible name to assert on, the mode that needs least setup. Those are exactly the choices that make a component easiest to check, which is a different objective from the choices a caller makes.

So the gate's reach is the union of the fixtures, not the union of the call sites, and the difference between the two is invisible from inside the test file. Worse, it is invisible in the *right* direction: the fixture is usually a richer configuration than the caller's, so the extra props tend to satisfy the rule rather than trip it. A gate that only ever sees well-dressed inputs reports green and keeps reporting green.

This is the same failure as [[lesson_a_probe_that_measures_too_early_reports_no_problem]] one axis over. There the measurement sampled the right thing at the wrong *time*; here it sampled the wrong *configuration*. Both produce a clean result that agrees with the answer requiring no further work, and both retire a question nothing downstream re-opens.

## What to do next time

- **Enumerate the callers before trusting a baseline.** Grep the call sites and compare the props they pass against the props the fixture passes. A prop that only ever appears in tests is the finding.
- **Render every branch the component has, not the convenient one.** A `mode`, a `kind`, an empty-vs-populated collection: each is a separate baseline. One assertion per state is cheaper than one violation discovered at migration time and misattributed.
- **Add the caller's own configuration as an explicit case,** named for what it is: `PickerModal.test.tsx` now has "has no accessibility violations as the callers actually render it", which is worth its awkward title because the title is the point.
- **Mutate the fix and watch the named test die.** Both of these were confirmed by removing the `aria-label` fallback and checking that the caller-shaped assertion, and only it, went red. Same discipline as [[lesson_a_test_that_passes_against_the_broken_code]].

## Related

- [[concept_axe_accessibility_gate]] - the gate this bounds, and where the ceiling is written down
- [[gotcha_axe_accepts_a_placeholder_as_an_accessible_name]] - the specific rule that let both instances through
- [[lesson_a_probe_that_measures_too_early_reports_no_problem]] - the same failure on the time axis rather than the coverage axis
- [[lesson_a_gate_that_cannot_fail_is_not_a_gate]] - the family both belong to
- [[lesson_a_test_that_passes_against_the_broken_code]] - the mutation discipline that confirms a fix is actually pinned
- [[component_picker_modal]] - the component whose green was measured on markup the app never renders
