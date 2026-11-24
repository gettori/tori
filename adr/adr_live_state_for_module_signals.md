---
summary: superseded in stage D (#109): module signals are plain createSignal again, and an edit that must see this tick's writes reads through an updater
status: stale
updated: 2026-11-24
source: plan "Solid 2 stage C: the switch to Solid 2.0" (gettori/tickets#108); superseded by stage D (gettori/tickets#109, branch `solid-2-stage-d-write-the-app`, commit c966679e)
---

# Module signals flush on write until #109

## Superseded

Stage D deleted `src/lib/liveState.ts`. Module state is plain `createSignal` and `createStore`. A write that has to build on an earlier write from the same tick reads through an updater, or through a small helper built on one (`latestTabModel`, `latestTerminalModel`, `latestPlacements`, `latestEnvelopes`). Shell commands that read state back through memos between steps call a local `settle()`, which flushes unless it runs under an owner. Tests flush between a write and a read. See [[gotcha_solid_2_reads_are_stale_until_flush]].

## Context

On 1.9 a signal write was visible at once. On 2.0 a read returns the old value until the next flush. The app has about 200 module level signals and stores, and many handlers write one and read it back in the same tick.

## Decision

Module level state uses `createLiveSignal` and `createLiveStore` from `src/lib/liveState.ts`. Each write flushes, unless it runs under an owner, where `flush` throws or runs other effects early. An effect callback that must land a write now, before a later write in the same tick, wraps it in `withoutFlush`. Otherwise it defers the write with `queueMicrotask`.

## Alternatives rejected

- Auditing all 203 sites by hand: a missed site is a silent bug. With the wrapper, the utils test failures fell from 176 to 4 with no test edits.
- Calling `flush` at each caller: the same audit, spread across every handler.

## Consequences

Today's behaviour holds through the switch, at the cost of more synchronous flushes than 2.0 wants. Writes under an owner still see stale reads, so a whole record update there needs an updater, see [[gotcha_solid_2_reads_are_stale_until_flush]]. #109 removes the wrapper.

## Related

- [[concept_solid_2_conventions]]: the module state rules that replaced this
- [[adr_port_resources_by_shape]]: the other 1.9 preserving decision in the same switch
- [[gotcha_solid_2_render_during_setup_flushes_other_effects]]: why the wrapper refuses to flush under an owner
