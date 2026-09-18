---
summary: a paint time that exactly equals the last IPC return is not render cost, nothing painted until the work stopped
status: current
updated: 2026-08-20
source: Worktree and tab switching at native speed (personal/tori, branch `unified-tab-bar`), Phase 1, commit 4b8287f, `src/utils/perfTrace.ts`
---

# A paint time equal to the last invoke is starvation, not render cost

## What happened

The first baseline said a worktree switch painted in 672ms while an agent was
streaming, and the *same* switch painted in 180-350ms when the app was busier.
Faster under load is the wrong direction, so the instinct was to distrust the
instrument. The instrument was right.

## Why

In the idle pass, `paint` equalled the end of the last invoke on every single
switch: 672/672, 638/638, 663/663, 651/651, 680/680, 704/704. Six exact
matches is not rendering cost, it is the main thread never getting a frame in
until the whole serialized IPC storm drained. Under streaming, terminals force
frames through, so a frame landed mid-storm and `paint` dropped to ~150-350ms
while `settled` stayed ~700ms. The idle number was measuring **starvation**.

## What to do next time

**When a measured endpoint tracks another number exactly, suspect that you are
measuring the wrong thing.** A paint that equals the last IPC return is not
telling you what painting costs, it is telling you nothing painted until the
work stopped. Two habits follow from this:

- Always record **paint and settled separately**. One number would have hidden
  which half was starved.
- **Treat a counter-intuitive row as a finding to explain, not an outlier to
  drop.** The streaming row being faster than the idle row is what identified
  main-thread starvation as the real problem, which is what
  [[adr_no_sync_ipc_commands]] was written to fix. After the fix, the ordering
  inverted to normal: 65ms idle, 39-47ms streaming, and settled followed the
  data legs.

## Related

- [[concept_release_profile_tracing]] - the separate endpoints this argues for
- [[adr_no_sync_ipc_commands]] - the fix this finding motivated
- [[lesson_an_occluded_window_reports_no_paint]] - the other way a paint number lies
