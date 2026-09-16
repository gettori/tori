---
summary: a finished usage chart was deleted before shipping since samples only cover time the app happened to run, mostly holes
status: current
updated: 2026-09-06
source: "Agent usage preview plan (personal/sway, branch `agent-usage`), phase 5, tasks 2 and 3 cancelled . PR #169 . the deleted `usageHistory.ts`, `UsageHistory.tsx` and the ring in `src-tauri/src/usage_snapshot.rs`"
---

# Do not chart sampled data until you know how much of the window you were awake for

## What happened

A 7-day usage history was planned, built whole and passing, and then deleted before it shipped. It had a step-line chart over a bounded per-account ring, a dialog, a command binding, a link on the usage card, and an extra Codex read folded into the existing probe. The question that killed it took one sentence: what does the chart show for a developer who did not open Sway for two days and worked from the Claude CLI or the desktop app instead?

Nothing. The quota went on moving the whole time and Sway recorded none of it, because the only samples it can ever hold are the ones it was running to take. The honest chart on a real machine is mostly hole, and a chart with holes in it does not read as "no data here", it reads as "flat here", which is the opposite of what happened.

## Why

The window belongs to the account, not to Sway. Sway's samples are a record of **what Sway read**, and a visualisation over them silently reframes that as a record of what the account did. Every gap-filling choice available makes it worse: interpolating invents usage, dropping to zero invents a reset, and a gap drawn honestly is most of the picture.

The ring went with the chart, which reached back three phases into code that had shipped: it existed for exactly one reader, and a file growing on disk for nobody is worse than no file. Removing it needed care in one place only, that snapshots already written carry the old key, so serde reads past it and the next save drops it, pinned by a test.

## What to do next time

Before building any history view over data you sample yourself, answer two questions with numbers: **what fraction of the window is your process running for**, and **what does the reader conclude from a gap?** If the process is not the only writer of the underlying fact, and it is not always running, then a chart is a claim you cannot support. Show the level now and when it resets, which is what the question was actually about.

The corollary is about sequencing. This one was found by describing the finished feature to its user in one sentence, which is cheap and was available before any of it was written. Do that first for anything whose value depends on data completeness.

## Related

- [[component_usage_pipeline]] - what remains: one snapshot of the current levels, no ring
- [[concept_quota_is_an_account_fact]] - absence is a property of the source, the same rule this is an instance of
- [[adr_usage_source_ladder]] - the decision this amended
