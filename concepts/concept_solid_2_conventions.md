---
summary: how Tori writes Solid 2.0.3 code: fetch rule, actions over plain saved signals, projected row flags, plain module signals, a shrink-only diagnostics gate
status: current
updated: 2026-11-25
source: plan "Solid 2 stage D: write the app the 2.0 way" (personal/tori, branch `solid-2-stage-d-rest`, gettori/tickets#109); vite.config.ts (lint.jsPlugins), src/test/solidDiagnostics.ts, src/test/solidDiagnosticsLedger.json, src/lib/byKey.ts, src/test/solidProbe*.test.tsx; commits 04e4daba, c966679e, a557a7cd, dab2c717, 1981349c
---

# Solid 2 conventions

Stage D (gettori/tickets#109) removed the two shims stage C left behind to keep 1.9 behaviour: `createFetchState` ([[adr_port_resources_by_shape]]) and the flushing module signals ([[adr_live_state_for_module_signals]]). Both ADRs are superseded. This page is the set of rules the code follows now on solid-js 2.0.3, and the gate that keeps it there.

## Fetch rule

A fetch is an async memo, `createMemo(() => invoke(...))`, read under `<Loading>` and `<Errored>`.

- **First load:** the `<Loading>` fallback. Use `loadingValue` only where the empty state is honest.
- **Subject change** (another session, file or pull request): a placeholder through `<Loading on={subject}>`.
- **Same subject, changed input:** hold and dim with `isPending`. Controls read `latest`.
- **Same question asked again** (a poll, an fs event, `refresh`): silent. `isPending` does not report a `refresh`, and a signal set beside a `refresh` joins the held transition. To show a re-ask, key a `createDeferred` on a counter.
- **Rejection:** shown through `<Errored fallback={(err, reset) => ...}>`, never caught to an empty value.
- **Boundary placement:** `isPending` read outside a boundary raises `ASYNC_OUTSIDE_LOADING_BOUNDARY` and holds the frame. A memo that goes from null to a promise holds the click that caused it. A child component that owns its memo is a promise from mount, so put such a fetch in a child.

A read whose failure must not hide its surroundings becomes a value instead of a boundary: a deferred that resolves to `{rows, failed?}` or `{row}` or `{error}`.

## Actions

A mutation whose failure must undo the screen is an `action(function* ...)` that guesses through `createOptimistic`. Only optimistic writes revert. A plain signal written inside a failing action is committed anyway (probe P3 in `src/test/solidProbeActions.test.tsx`). So the committed value lives in a plain `saved` signal:

```ts
const [saved, setSaved] = createSignal<boolean | null>(null);
const [off, setOff] = createOptimistic(() => saved() ?? read().disabled);
const use = action(function* (on: boolean) {
  setOff(!on);
  try { yield save(!on); } catch (e) { toast(e); return; }
  setSaved(!on);
});
```

- Never call `flush()` inside an action body.
- A teardown, stop or cancel stays a plain call: its local write must stand whether or not the backend answers.
- `createOptimisticStore` is used only where a probe passes. On 2.0.3 the following are still broken, and each has a `test.fails` probe that turns red when upstream fixes it:
  - a move between two optimistic lists after a shared re-ask (#5104);
  - a projection over an optimistic store (#5117);
  - a guess made before the node's first answer (#5118).
- An action called from a keyed row's cleanup throws in dev (#5123), so a mutation that runs from a cleanup stays a plain call.

## Lists

- **Identity first.** `<For each>` keys rows by item identity, so a source that rebuilds its objects remakes every row. Keep the objects a fresh read did not change, as `keepDrawn` does in the file tree. A `keyed` function does keep the rows, but it writes a new object into every kept row's accessor, which woke every row (27 reruns against 5).
- **Per row flags are projections.** A row that reads a whole Map, Set or selected id wakes on every change. `byKey(() => map)` and `flagsOf(() => keys)` in `src/lib/byKey.ts` build a `createProjection` the row reads by its own key. Both are listed under `customReactiveFunctions`.
- **A store array goes to `<For>` as is.** Hide a row inside it, with `<Show>`, instead of filtering a copy.
- **No `<Repeat>` for the transcript.** `<Repeat>` keys by position, and the message list's rows are regrouped runs. A row that iterates a store array costs O(n) on its disposal (#5120, `src/test/solidProbe5120.test.tsx`), so rows read a copy or their own item.
- **Census.** `countingSolid` counts the rows each `<For>` makes and disposes, and each render budget scenario pins what it saw.

## Module state

- Module scope signals and stores are plain `createSignal` and `createStore`. Moving them into Providers was ruled out at the epic level, which is why `no-module-scope-reactive-primitive` is off.
- A write is not visible until the flush. An edit that must see this tick's writes reads through the updater form or a local value, not a fresh read.
- `flush()` is not allowed in an effect callback or an action. A handler that must read the tree back through memos calls a local `settle()`, which flushes only when not under an owner.

## Lint and diagnostics gate

- **Lint:** `eslint-plugin-solid` v2 plus v2-strict, without `no-module-scope-reactive-primitive`, wired through `lint.jsPlugins` in `vite.config.ts`. `vp lint --deny-warnings` fails CI.
- **Deliberate one-time reads:** a read in a component body, or the top of a flow callback, gets `untrack`. The shipped `reactivity-diagnostics` skill warns against `untrack` to silence a warning. Stage D used it anyway, but only on reads judged deliberate. Wrapping a read that already did not track changes nothing, and the stale ones were fixed instead. The rejected alternative was to pass the tracked value from compute to apply and to seed with `createSignal(() => props.x)`: both change behaviour at every site, and a derived seed resets whenever its prop moves. The cost is that a read wrongly judged deliberate no longer reports.
- **Callback helpers** go under `customReactiveFunctions`.
- **Diagnostics gate:** `src/test/solidDiagnostics.ts` fails a test file whose dev diagnostics exceed its entry in `src/test/solidDiagnosticsLedger.json`.
  - The ledger only shrinks. `SOLID_DIAGNOSTICS_SHRINK=1 vp test run --reporter=default --reporter=./scripts/solid-diagnostics-reporter.mjs` lowers it, so run it only on a full suite, never on a scoped run.
  - `$reasons` in the ledger gives every remaining entry a reason. The reporter keeps every `$` key when it rewrites the file. Stage D cut the ledger from 174 files and 29,053 strict reads to 17 files and 35 strict reads. Deliberate reads went under `untrack`, and the stale reads the census found were fixed, each with a test. What remains is reads it could not locate, test code and upstream repros.
  - `HOT_SCOPE_TIME` is ungated, because it follows machine load.
  - The `$dev` section records a scripted dev pass by flow.
- **Rerun budgets:** each render scenario has a `renders.*.reruns` row, counted through `toStayWithinRerunBudget`, beside the memo, effect and mutation rows in [[concept_perf_budgets]].

## Related

- [[adr_port_resources_by_shape]] the stage C fetch shim this replaced
- [[adr_live_state_for_module_signals]] the stage C flushing signals this replaced
- [[concept_perf_budgets]] where the render and rerun rows live
- [[gotcha_a_for_over_an_array_rebuilt_from_props_recreates_every_row]] the identity trap behind the list rules
- [[lesson_a_diagnostics_ledger_shrinks_by_census_not_by_reading]] how the ledger was cleared
- [[gotcha_a_beforeeach_arrow_that_returns_a_mock_hangs_the_suite]] a trap hit while testing the actions
