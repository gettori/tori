---
summary: a new test file adding load can push an unrelated test past its timeout, reading as a regression in the wrong suite
status: current
updated: 2026-08-15
source: "plan \"Select wrapper and native select migration\" (personal/sway, branch `106-select`, issue #106); `vitest.config.ts` (dom project `testTimeout`); `src/components/Dialogs/ProjectIconDialog.test.tsx`, `src/components/Dialogs/SpaceDialog.test.tsx`"
---

# An added test file can fail an unrelated one, and the timeout is the bug

## What happened

Adding two new test files to #106 broke two axe tests in dialogs the ticket never touched (`ProjectIconDialog`, `SpaceDialog`). The failure read as an accessibility regression at first glance, in the suite whose whole point is catching those. It was `Error: Test timed out in 5000ms`, and the two tests had been measuring 5.2 to 6.8 seconds.

## Why

Those two scans run axe over large icon grids and already cost roughly 5 seconds under a full run's parallel load, which is exactly vitest's default `testTimeout`. They were passing on the margin. Two more files meant more workers running axe at once, and the margin went.

Nothing was wrong with the new tests or the old ones. The suite was standing on a cliff nobody had chosen: 5s was a default, never a decision, and the first person to add a file was going to go over it whoever they were.

The diagnosis is the reusable part, because "my change broke an unrelated a11y test" invites you to go looking in your own diff:

1. The two failed **in isolation? no**, they passed. That rules out a genuine violation.
2. A full run with **only the new files excluded** passed 265/265. That confirms the new files are the trigger.
3. Trigger is not cause. A file that adds load cannot make another file's markup inaccessible, so the only thing left is time.

Step 2 is the one worth remembering. It separates "my change is the trigger" from "my change is the fault", and those call for opposite fixes.

## What to do next time

**Read the failure text before believing the test name.** A timeout inside an assertion reports under whatever the test was called, so an a11y test that times out reads as an a11y failure.

**When an unrelated test fails, run it alone, then run the suite without your new files.** Passing alone plus failing together means resource contention, not correctness. Do that before reading your own diff again.

**Fix the limit, not the symptom.** The temptation is to make your own tests cheaper until the suite goes green, which puts it right back on the same margin for the next person. If the slow work is legitimate (an axe scan over a hundred controls is), raise the timeout and say why in a comment.

Cheapening your own tests is still right when they were wasteful. In #106 a pane-wide axe scan was dropped for that reason, but it was dropped because it was redundant and asserted things the ticket did not own, not to buy back milliseconds.

## Related

- [[concept_axe_accessibility_gate]] — the gate involved, and why its scans are expensive under jsdom
- [[component_select]] — the ticket that surfaced this
- [[lesson_shared_state_makes_a_test_order_dependent]] — the other way a suite passes for a reason that is not the code
- [[lesson_debug_the_harness_before_recording_the_outcome]] — same instinct, one level up
