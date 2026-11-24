---
summary: "superseded 2026-11-24: #109 removed createFetchState, fetches follow the fetch rule (async memo under Loading and Errored)"
status: superseded
updated: 2026-11-24
source: plan "Solid 2 stage C: the switch to Solid 2.0" (personal/tori, branch `solid-2-stage-c-the-switch`, gettori/tickets#108); superseded by plan "Solid 2 stage D: write the app the 2.0 way" (branch `solid-2-stage-d-rest`, gettori/tickets#109), commit `e6781163` and the shim's removal
---

# Port each resource by what its callers read

## Superseded

Superseded on 2026-11-24 by gettori/tickets#109, which deleted `createFetchState`. Fetches now follow the fetch rule, see [[concept_fetch_rule]]: a first load shows a `<Loading>` fallback, a subject change uses `<Loading on>`, a re-ask with the same subject is held with `isPending`, and a poll or `refresh` re-ask is silent. A rejection shows through `<Errored>` instead of being caught inside the fetch. The record below is the stage C decision as it stood.

## Context

2.0 has no `createResource`. The app had 75, and only one was read under a loading boundary. The rest showed `undefined` while loading, which is the behaviour the switch had to keep.

## Decision

Pick the form from how callers use the resource:

- Read under a `<Loading>` boundary: async memo under `<Loading on>`.
- Fetcher only, no `.loading`, `.error` or `.state` read: `createMemo` with `loadingValue`.
- Source driven, no `.loading` read on first load: `createDeferred` with `loadingValue`, and `isPending` where the code reads `.loading`.
- Uses `refetch` but reads no `.loading`: the same forms with `refresh()`.
- Reads `.loading`, `.error` or `.state`, or uses `mutate`: `createFetchState`, a signal plus effect helper listed for removal in #109.

Every async memo catches inside its fetch, because an uncaught rejection raises `REACTIVITY_HALTED` and nothing updates after it.

## Alternatives rejected

- Plain `createMemo` for a source driven resource: a probe showed it holds every sibling write until the fetch lands.
- `<Loading on>` everywhere: it flashes a fallback where the screen shows nothing today.
- The helper everywhere: it matched 1.9 on every probe row, but would leave all the sites for #109 to redo.

## Consequences

Several shapes live side by side until #109 moves them to the full 2.0 async model. ~~A fetch that rejects often resolves to empty, so a failure can look like no data.~~ **superseded 2026-11-24.** A rejection reaches `<Errored>`, except where a ledgered reason keeps a value.

## Related

- [[adr_live_state_for_module_signals]]: the other 1.9 preserving decision in the same switch
