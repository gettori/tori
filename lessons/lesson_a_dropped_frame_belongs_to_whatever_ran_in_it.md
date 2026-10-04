---
summary: a candidate whose frame dropped is worth moving only if its own seam carries the cost; lex, fuzzy, tool diff did not
status: current
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7, phase measure-candidates and the dropped phases markdown-tail-lex, fuzzy-in-rust, tool-diff-in-rust, chunked-payloads
---

# A dropped frame belongs to whatever ran in it

## What happened

The gate said build for five candidates. For three of them the work the fix would move was small: the streaming lex never passed 7ms while its worst frame was 29 to 44ms, the tool diff was 4 to 10ms of a 34 to 50ms frame (the rest was mounting the card), and fuzzy matching over 50k paths was 10ms typical with no frame dropped. Building any of them would have left the frame where it was.

## What we learned

A frame over the gate says the main thread was busy, not who was busy. The seam's own time says how much a fix can take back.

## What to do differently

- Read the seam column before the frame column. Build only where the seam is most of the frame.
- When the frame is mostly something else (rendering, layout), measure that thing as its own seam rather than moving the wrong one.
- Single-sample rows move 30 to 50% between runs; take two runs before closing a verdict.
- The invoke size column needs a big repo to mean anything; this repo's largest answer was 63 KB.

## Related

- [[lesson_frame_gap_minus_a_normal_frame_undercounts_a_task]]: the earlier misreading of the same rows
- [[component_perf_trace_harness]]: where the rows come from
