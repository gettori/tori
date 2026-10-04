---
summary: a task pushes the next paint out by its own length, so frame gap minus a normal frame reads a 30ms task as 13ms
status: current
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7, phase measure-candidates; `scripts/trace-report.mjs` work section, `src/utils/perfTrace.ts` `traceWork`; commit 5f652e30
---

# Frame gap minus a normal frame undercounts a task

## What happened

The work report first charged each seam its frame gap minus the pass's median empty frame. A calibration pass that ran a 30ms busy loop read 13 to 14ms, because the gap around it was 30 to 31ms: work that starts at a frame pushes the next paint out by about its own length, so subtracting a normal frame removes time the task really held.

## What we learned

A meter that has not read a known load is not a meter yet. And the frame gap is already the time the screen could not paint; it needs no subtraction once a frame has dropped.

## What to do differently

- Put a calibration row in any new timing rig, a busy loop of known length, and read it before any other number.
- Charge a dropped frame (gap at least 1.5x the control) its whole gap, and never charge a sync seam less than its own time. That rule reads the 30ms loop as 30 to 31ms.
- WebKit clamps `performance.now()` to whole milliseconds in this build, so a seam under a millisecond reads 0.

## Related

- [[component_perf_trace_harness]]: the rig this fixed
- [[lesson_a_same_state_control_row]]: the control row the subtraction leaned on
- [[lesson_a_dropped_frame_belongs_to_whatever_ran_in_it]]: the next mistake in reading the same numbers
