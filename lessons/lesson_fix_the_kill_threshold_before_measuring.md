---
summary: a kill threshold written after the numbers are known is a justification, not a threshold, fix it before the spike
status: current
updated: 2026-07-29
source: Chat surface plan, phases 2, 4, 9, 10 (branch `chat`); thresholds recorded in the plan's "Kill thresholds (fixed before measurement)" table
---

# Fix the kill threshold before you measure

## What happened

A twelve-phase plan wrote its kill thresholds into the plan document *before* any
spike ran, then measured. Three phases died on their own numbers: the lost-update
guard (7.5% spurious denials against a 1-in-20 line), the attribution log layout
(`overlapping_turn` at 6.4 to 9.0ms against 50ms) and the migration that depended
on it. Roughly a third of the planned work was cancelled by evidence, and the
plan had been sequenced so that cutting it cancelled nothing else.

## Why

A threshold written after the numbers are known is not a threshold, it is a
justification. The plan said so explicitly: "Written here rather than recorded
during Phase 2, so the measurement can fail." The 7.5% result is the proof that
it worked, because 7.5% against a 5% line is close enough that it would certainly
have been renegotiated if the line had been drawn afterwards.

The second half is structural. The plan's dependency graph was deliberately
arranged so that no deliverable was chained through the conditional layout work:
"an earlier draft chained the guard, rewind and rules through the migration,
which meant the most likely measurement outcome would have cancelled every
differentiator in the plan."

## What to do next time

- **Write the number and the unit into the plan before the spike, next to what it
  gates.** State it as "cut unless X exceeds Y", so the cut is the default and
  building is what needs evidence.
- **Sequence conditional work so a cut cancels only itself.** If a cut would take
  out unrelated deliverables, the dependency is probably invented.
- **Apply the threshold as written even when the result is close.** Record the
  near miss and the idea that might clear it (here: comparing content rather than
  a sha, or exempting append-mostly files) so a future attempt starts from the
  data instead of re-running the spike.
- **A timeboxed spike reports "not found within scope", never "impossible".**

## The measurements themselves

Recorded here because the spike code was deleted and these numbers *are* the
artifact. Taken 2026-07-28/29, M-series mac, APFS, warm page cache, against
claude 2.1.220. The 5x to 45x margins mean the cache caveat does not change any
verdict.

| Measured | Result | Threshold | Verdict |
|---|---|---|---|
| `overlapping_turn` at 10k turns | median 6.4 to 9.0ms/call, worst 11.6ms | over 50ms | under, **cut** |
| Cold-start session scan at 200 sessions | median 6.6ms, worst 10.1ms (16.7ms at 500) | over 300ms | under, **cut** |
| Claims rewrite at 10 claims | median 0.14ms (1.2ms at 200, worst 3.3ms) | over 10ms | under, **cut** |
| Spurious denials, contended (2 sessions, same 3 files) | 13 of 34 writes, **38.2%** | over 1 in 20 | over, **cut** |
| Spurious denials, disjoint (shared `NOTES.md` only) | 3 of 40 writes, **7.5%** | over 1 in 20 | over, **cut** |
| Steer latency to act (3 trials) | 1633ms / 5365ms / 1468ms, 0 tool calls after | buffered to turn end | consumed early, **build** |

Two results carry shape as well as size. Every conflict in the *disjoint*
workload landed on the single genuinely shared file, and half of those were
spurious: the guard's problem is not that it fires too widely, it is that where
it does fire a sha comparison cannot tell "you already have this content" from
"you are about to clobber someone". Comparing content, or exempting
append-mostly files, is the untested next idea. And the claims row measured only
cost; see [[lesson_a_cut_settles_only_what_was_measured]].

## Related

- [[lesson_a_cut_settles_only_what_was_measured]] - the sharp edge of this practice
- [[lesson_debug_the_harness_before_recording_the_outcome]] - a wrong number is worse than none
- [[concept_evidence_tiered_attribution]] - the same "measure, do not assert" habit in code
