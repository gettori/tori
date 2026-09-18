---
summary: a new check can look finished and catch nothing, so write its verify as positive detection and break it once on purpose
status: current
updated: 2026-08-12
source: "plan \"axe-core harness in the jsdom vitest project\" (personal/tori, branch `97-axe-core`, issue #97); `src/test/axe.test.tsx`, `src/test/axeUsage.test.ts`, `src/components/SegmentedControl/SegmentedControl.test.tsx`; commit 0010b81"
---

# Make a new gate fail once before you trust it

## What happened

Building the axe gate produced three separate places where the work would have *looked* finished while enforcing nothing, and all three were caught by deliberately trying to make the new check fail rather than by watching it pass.

1. **The spike's success condition was the risk.** The plan's first draft verified the spike as "`axe.run` resolves rather than throwing on a missing DOM API". But jsdom gives every element a zero-size rect and a null `offsetParent`, and axe by design "only checks rendered content". If that made axe treat the whole tree as unrendered, `axe.run` would resolve *cleanly with an empty `violations` list*, satisfying the verify exactly. The verify was inverted to require a known-bad fixture to actually produce `button-name`, with an empty list redefined as a spike **failure**.
2. **The example assertion could not fail.** The plan originally put the copy-pattern on `Button`. An isolated `<button aria-label="…">` cannot trip a WCAG A/AA rule, so the assertion would have been decorative and would have taught 200 future test files a ritual. It moved to `SegmentedControl` plus a **negative twin** that renders icon-only segments with no name and asserts the gate catches it.
3. **The gate's own enforcement was one forgotten keyword from off.** `expectNoAxeViolations` is async and reports by throwing, so a call site missing `await` schedules the check, returns, and passes. There is no linter in this repo. A `?raw` source scan (`axeUsage.test.ts`) now asserts every call site is awaited, and it was validated by deleting a real `await` and confirming it went red.

## Why

A gate has two failure modes and they are not symmetric. Reporting a defect that is not there is loud and gets fixed immediately. Reporting nothing when a defect is there is silent, indistinguishable from health, and accumulates trust it has not earned. Watching a new check pass only ever exercises the first mode.

This bites hardest where the environment is a partial simulation of the real one. Under jsdom, "no violations" and "could not look" are the same observation from the outside, so the only way to tell them apart is to hold up something known-broken and confirm the check reacts.

The same shape already had an instance one layer down: [[lesson_a_rule_that_matches_nothing_passes_every_guard]], where a CSS override was written, visible, verified, and inert because its selector matched nothing that existed. That was about names versus reachability in a static scan. This is the test-assertion form of it.

## What to do next time

**Every new guard, assertion, or gate gets a red run before it is trusted.** Concretely:

1. **Write the verify condition as a positive detection, never as an absence.** "It resolves", "no errors", "the list is empty" are all satisfied by a check that never looked. State the defect the check must catch and assert it catches it.
2. **Ship a negative twin next to any assertion whose subject passes trivially.** If the fixture cannot break the rule being asserted, the assertion is documentation, not enforcement. Prefer a subject with a real invariant (`SegmentedControl`'s required accessible name) over the simplest one that compiles.
3. **Break it on purpose, once.** Remove the `await`, strip the label, mutate the fixture; confirm red; restore. This is cheap and it is the only direct evidence that the wiring is connected.
4. **Guard the guard's own preconditions.** A scan that matches zero files passes forever: `axeUsage.test.ts` asserts it found at least one call site before asserting they are all awaited.
5. **When a helper reports by throwing asynchronously, assume a call site will forget `await`** and add a source scan, since this project has no linter to catch a floating promise.

## Related

- [[concept_axe_accessibility_gate]] — the gate this hardened, and the four false-green paths it closes.
- [[lesson_a_rule_that_matches_nothing_passes_every_guard]] — the same inert-guard shape in CSS selectors; "a guard that cannot fail on the bug you are about to write is not protecting you from it".
- [[lesson_a_test_that_passes_against_the_broken_code]] — the neighbouring failure: a test that runs but proves nothing.
- [[lesson_a_test_can_pass_because_its_fixture_stopped_parsing]] — a green signal that means nothing, from the fixture side.
- [[gotcha_axe_files_what_it_cannot_judge_under_incomplete_not_violations]] — the specific trap that motivated point 1.
