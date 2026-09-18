---
summary: unit sensitive code needs realistic magnitude fixtures, round numbers like 100 200 300 cannot reveal a wrong unit
status: current
updated: 2026-07-20
source: "Status deepening: checkpoint timeline, tree revert, touched markers, live indicator (personal/tori, branch `main`); Phase 1; `src-tauri/src/checkpoint.rs`"
---

# Synthetic test values hide unit bugs — pin unit-sensitive code with realistic magnitudes

## What happened

`checkpoint_revert_tree` snapshots the current tree as a labeled "backstop" checkpoint before restoring, so a revert is itself revertible. The backstop's timestamp was stamped with `as_millis()`. Every other checkpoint boundary comes from `parse_rfc3339_secs` (`sessions.rs`), so they are epoch **seconds**.

The backstop therefore landed roughly 1000x above every real boundary. Because checkpoints resolve by nearest-neighbor-in-time ([[lesson_checkpoint_refs_keyed_by_timestamp]]), that sorts every post-revert turn *before* the backstop, and `tree_at_or_before` resolves the wrong tree — silently, in the exact feature whose whole promise is "you can get back".

The unit tests did not catch it. They used synthetic timestamps: 100, 200, 300. Those sit below *both* scales, so seconds and milliseconds are indistinguishable to every assertion in the suite. The bug was found by reading the diff in self-review, not by the tests that nominally covered the code.

## Why

A test fixture chosen for readability optimizes for the wrong thing when the code under test is unit-sensitive. Small round numbers are easy to reason about precisely *because* they carry no scale information — which is the one property that makes them unable to distinguish a unit error. The suite was measuring ordering logic correctly while being structurally blind to the dimension that was actually broken.

This is not "write more tests". The coverage was there. The *fixtures* could not fail.

## What to do next time

When a value's **unit** is part of its contract (epoch seconds vs millis, bytes vs KB, radians vs degrees, cents vs dollars), pick fixture values whose **magnitude differs between the candidate units**, so a wrong unit produces a wrong ordering or a wrong comparison that some assertion can see. Realistic values do this for free; 100/200/300 never can.

Concretely: `backstop_is_stamped_in_seconds_so_later_turns_sort_after_it` now uses realistic epoch-second timestamps and was verified to **fail against the old code** before being kept. A regression test that has not been watched to fail is an assumption, not a test.

Also worth generalizing: the bug lived at a **boundary between two producers** of the same conceptual value (one parsing RFC3339 into seconds, one reading the system clock). Those seams are where unit mismatches concentrate, and neither producer is wrong in isolation.

## Related

- [[component_turn_checkpoints]] — the backstop mechanism this bug lived in.
- [[lesson_checkpoint_refs_keyed_by_timestamp]] — why ordering-by-timestamp is load-bearing here, which is what made the unit error consequential rather than cosmetic.
- [[lesson_verify_after_the_last_edit]] — a sibling lesson about verification that measures the wrong moment.
