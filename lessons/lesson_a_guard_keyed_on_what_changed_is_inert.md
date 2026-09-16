---
summary: a latest-wins guard keyed on what changed (like position) never fires, key it on the display surface instead
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/sway, branch `wave-7`); Phase 7 (commit a862bbe); `src/panels/Editor/peekLocations.ts`; issue #66"
---

# A latest-wins guard keyed on the thing that changed can never fire

## What happened

The plan specified peek's ordering guard as "a latest-request-wins guard keyed on the peeked position". Written exactly that way it is **inert**. The guard exists for one case: the caret moved, two requests are out, and the older reply lands last. Keyed on the position, those two requests have two *different* keys, so neither ever supersedes the other and the stale reply publishes.

It was found only because the test written for the plan's stated behaviour failed. The implementation matched the specification; the specification was wrong.

## Why

A latest-wins key has to name the **scope the answer will be displayed in**, not the input that produced it. There is one peek widget, so the scope is "the peek", and the correct key is a single counter (`claimPeek()`) with no dimensions at all. The same reasoning explains why the neighbouring guards are keyed the way they are:

- Document symbols and code lens key on **path**: one store entry per file, and a newer ask about that file supersedes an older one.
- The code-action bulb keys on **path plus range**, because the bulb is drawn *for* a range, so two ranges really are two independent displays — and its post-await check compares against the range the call was started for, since a caret move only re-asks after a debounce.
- Call hierarchy keys on **path**, because there is one panel and one active file.

Adding the varying input to the key is a natural mistake because it reads like precision. It produces a guard that is present, tested-looking, and structurally incapable of discarding anything.

## What to do next time

**Key a supersede token on the surface that will show the answer, not on the request that produced it.** Ask "how many of these can be on screen at once?" If the answer is one, the key is a bare counter.

**Write the test for the race before the guard, and make it fail.** A latest-wins guard whose test only ever issues one request passes against an empty function body. Hold two replies, release them out of order, and assert the older one is discarded.

**Treat a plan's guard specification as a claim to check, not an instruction to transcribe.** This is the second wave-7 defect the plan's own wording would have shipped (the other being Phase 5's assumption that pushing settings was the delivery mechanism).

## Related

- [[component_peek_view]] — where this landed
- [[gotcha_a_request_bound_to_a_fast_changing_selection_needs_a_latest_request_wins_guard]] — the trap this sharpens: having a guard is not enough
- [[lesson_a_test_that_passes_against_the_broken_code]] — how the inert version would otherwise have survived
- [[component_call_hierarchy]] — the neighbouring guard, keyed on path for the reason above
