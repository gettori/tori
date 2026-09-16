---
summary: key a snapshot per event design by the event's own timestamp, not a count of artifacts produced, or a skip corrupts it
status: current
updated: 2026-07-18
source: Adapter registry, pulse, presence, checkpoints (personal/sway, branch `topbar`); Phase 4; `src-tauri/src/checkpoint.rs`
---

# Key checkpoint refs by boundary timestamp, not a sequential counter

## What happened

The plan's task wording implied refs named `refs/sway/checkpoint/<sessionId>/<n>` with `n` auto-incrementing per snapshot. Implementing that literally, then wiring per-turn diffs on top of it, surfaced a mapping problem before any code shipped: the same task also requires skipping a ref write when the computed tree is unchanged (an idle turn, or a duplicate trigger). The moment any boundary is skipped, `n` develops a gap, and a later turn's diff needs to know *exactly* which prior boundary to diff against — a gap silently breaks that mapping (which `n` is "the turn before this one" once some `n`'s never existed?).

## Why

A per-turn diff is fundamentally a lookup of "the checkpoint at this turn's start" and "the checkpoint at the next turn's start" — a relationship between *time-ordered* boundaries, not *sequence-ordered* ones. A monotonic counter conflates the two only when every boundary produces a ref; the "skip when unchanged" requirement (deliberately, to keep the ref list meaningful — see [[component_turn_checkpoints]]) breaks that conflation.

## What to do next time

Key checkpoint-like time-boundary refs by the **timestamp of the boundary itself**, not by a counter over "boundaries that produced a durable artifact." Then "before" and "after" a given boundary resolve as *nearest neighbor by time* (`nearest ref at-or-before`, `nearest ref strictly after`), which stays correct regardless of which boundaries were skipped — a skipped boundary is transparently absorbed into the next real diff instead of corrupting the index. This generalizes beyond checkpoints: any "snapshot per event, but dedup when nothing changed" design should key its artifacts by the event's own identity (timestamp, id) rather than a count of artifacts actually produced.

## Related

- [[component_turn_checkpoints]] — where this landed; `tree_at_or_before`/`tree_after` are the nearest-neighbor resolvers.
