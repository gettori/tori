---
summary: a kill threshold with two clauses needs a verdict per clause, since the measured half can stand in for the whole
status: current
updated: 2026-07-29
source: Chat surface plan, phases 2 and 10 (branch `chat`); `src-tauri/src/chat/ownership.rs:237`; commit "Replace the claims file by rename, so a torn write cannot empty it"
---

# A cut settles only what was actually measured

## What happened

A phase's kill threshold read "cut unless the rewrite exceeds 10ms, **or a lost
claim is reproduced**". The spike measured the rewrite at 0.14ms and the phase
was cut. The second clause was never tested, because there was no deterministic
harness for a kill between write and fsync. Two sessions later the claims file
turned out to be written with a bare `std::fs::write`, which truncates in place,
while the plan's own layout table listed claims under "small map, atomically
replaced" and its decisions said losing the most recent claim "is precisely the
failure `ownership.rs` exists to prevent". Both readers ended in
`unwrap_or_default()`, so a torn file would have read back as *no claims at all*,
and every live session would have looked unowned to the next opener.

## Why

The cut recorded that the rewrite was cheap. It was read, by everyone downstream
including the phase that inherited the question, as recording that the rewrite
was *safe*. Cost and durability were two clauses of one threshold, and only one
of them had a number next to it, so the measured half silently stood in for the
whole.

The phase that was cut had flagged this itself, in a note listing two items that
"do not die with the cut and need rehoming before the ticket closes". That note
is the only reason the bug was found before a crash found it.

## What to do next time

- **When a threshold has two clauses, record a verdict per clause.** "Cost: under.
  Durability: not measured" is the honest summary; "cut" is not.
- **A cut phase still needs its orphans rehomed.** Write them into the phase notes
  explicitly, as work that survives the cut, or they vanish with the phase.
- **Prefer a property test to a crash simulation.** Durability here looked
  untestable, but the distinguishing property was not: `rename` swaps a directory
  entry, so a file handle opened before the save still reads the old bytes, while
  an in-place truncate rewrites the very file that handle points at. That is
  deterministic, runs in milliseconds, and was watched failing against the old
  implementation before the fix was trusted.

## Related

- [[lesson_fix_the_kill_threshold_before_measuring]] - the practice this qualifies
- [[component_chat_host]] - the claims store that was the outlier
- [[gotcha_a_truncating_write_under_a_lenient_reader_loses_data_silently]]
