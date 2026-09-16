---
summary: a settle span kind the tracer never admits waits the full timeout and writes null, looking like a slow switch not a bug
status: current
updated: 2026-08-26
source: Features phase 3 (#155), branch `feature-workspace`, `src/utils/perfTrace.ts:219`, `src/panels/LeftSidebar/LeftSidebar.tsx`, commit 4f852b0, _2026-08-26_
---

# A switch span whose kind the settle legs never admitted times out silently

Do NOT let `traceSettle` name the one span kind it admits: it tested `current.kind === "worktree"` and dropped every other leg, so the `kind: "feature"` spans `LeftSidebar` opens waited the full `SETTLE_TIMEOUT_MS` and wrote `settled: null`. Nothing reads as broken, since a null settle looks like a slow switch rather than a span nobody closed. Exclude the **tab** span, which genuinely has no data leg, and admit the rest. The legs must also agree on the key: `traceSwitchStart` moved from the bare Feature id to `featureKey(id)`, because both legs key on the workspace key. Why: a `SwitchKind` added later inherits nothing, and the failure is silent in the report it feeds, see [[concept_switch_cost_anatomy]].
