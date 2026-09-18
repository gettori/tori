---
summary: a PR cache held its lock across the HTTP fetch that filled it, so one slow request serialized every project's lookup
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phase 3 self-review (Major); commit 7f9be1a; `src-tauri/src/forge/prs.rs:106`"
---

# Never hold a cache lock across a network call

## What happened

The pull-request lookup took the global `PrCache` lock, missed, and then made the HTTP request **still holding it**. Every other project's lookup blocked behind one slow network call, and the cache existed to make things faster.

## Why

The obvious shape is "lock, check, fetch, store, unlock", which reads as one atomic operation and is easy to write as one scope. It is only wrong because the fetch is not a memory operation: it can take seconds, it can hang, and while it does, a lock meant to guard a `HashMap` for microseconds is serializing the whole app. The correct shape splits into two critical sections with the slow work outside both, and accepts that two callers may briefly duplicate a request. Deduplicating *that* is a separate mechanism (`SingleFlight`, `status.rs:198`), which is keyed and does not hold the cache lock while it waits.

## What to do next time

Take the lock, decide, drop it, **then** go to the network, and take it again to store the result. If duplicate in-flight requests are the actual concern, add a single-flight keyed on the request, do not solve it by holding a data lock. The tell is a `MutexGuard` that is still alive on the line where an HTTP call, a subprocess, or a filesystem walk happens.

## Related

- [[component_forge_client]] - where this happened
- [[concept_forge_rate_budget]] - the caches and the single-flight that replaced it
- [[lesson_pure_core_for_global_stores]] - the same module's other structural rule
