---
summary: to clear a dev diagnostics ledger, log each diagnostic's first app stack frame over one full run; a few sites carry most of the count
status: current
updated: 2026-11-25
source: plan "Solid 2 stage D: write the app the 2.0 way" (branch `solid-2-stage-d-rest`, gettori/tickets#109), phase conventions-and-numbers; src/test/solidDiagnostics.ts, src/test/solidDiagnosticsLedger.json, scripts/solid-diagnostics-reporter.mjs; commit d03f2467a
---

# A diagnostics ledger shrinks by census, not by reading

## What happened

The diagnostics ledger held 29,053 `STRICT_READ_UNTRACKED` across 169 test files. The counts were per test file, so they did not say which code to look at. `ownerPath` was empty for most reads, and `loc` named the JSX use site, which split one read into many.

## What we learned

One full dom run, with a temporary subscriber that keyed each diagnostic by its node name and the first app frame of `new Error().stack` (with `Error.stackTraceLimit` raised), found 208 sites. One `createSignal(valueTab())` seed in `Select.tsx` accounted for 4,600 of the reads. The census turns a count into a worklist. Some first frames are shared helpers, and their reads happen in a caller's effect callback, so a second look at the caller is needed.

## What to do differently

- Census before fixing. Split the sites by area for parallel sweeps.
- Untrack only the reads that are deliberate, fix the stale ones with a test, and shrink with one full run of `SOLID_DIAGNOSTICS_SHRINK=1` and the reporter.
- Give whatever is left a line in `$reasons`.
- Delete the census logger afterwards: it slows every diagnostic.

## Related

- [[concept_solid_2_conventions]] the gate and the untrack tradeoff
