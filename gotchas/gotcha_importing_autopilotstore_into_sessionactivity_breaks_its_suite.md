---
summary: autopilotStore in sessionActivity pulls settingsStore and localStorage, breaking its node suite; feed state in instead
status: current
updated: 2026-09-26
source: plan "Autopilot hard lock, release on stop, reconcile on start (#209)" on branch orchestrator, issue gettori/tori#209; commits 28f747ed, 32def50a, f29dfcbd
---

# Importing autopilotStore into sessionActivity breaks its suite

Don't import `src/utils/autopilotStore.ts` into `src/utils/sessionActivity.ts`. The store imports `settingsStore`, which touches `localStorage` at load, and `sessionActivity.test.ts` runs in a node environment, so the whole suite fails to load with no tests run. Feed what it needs in through a `note*` setter, like `noteLiveTabs`, or let Rust read it: the worker notification rule that once needed the autopilot's on state now reads the runner in Rust ([[component_presence]]). Why: sessionActivity's inputs are all fed from outside, which keeps its tests free of the app's stores.

## Related

- [[component_presence]]: the worker notification rule, now in Rust
- [[component_autopilot_cockpit]]: where `autopilotStore` lives
