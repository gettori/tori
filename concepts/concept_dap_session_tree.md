---
summary: a debug run is always a tree, even node one file.js makes a root plus a child, so no code may assume a single session
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/sway, branch `wave-8`); Phases 1, 3; epic #69; `src/utils/dapSessions.ts:145`, `src/utils/debugStack.ts:239`; commit 1e72ae1"
---

# A debug run is a tree of sessions, and always has been

The single most consequential thing Phase 1's spike measured, and the one the plan had wrong: **there is no single-session case**. Even `node one-file.js` produces a root session plus a child, and the root never stops. A test runner is three or four levels deep. Every part of the debugger is shaped by that, and anything written as if a run were one connection is wrong in the common case, not the exotic one.

## How it works

js-debug issues a **`startDebugging` reverse request** whenever the program it is debugging spawns another one. The client answers by opening a *second connection to the same adapter server*, carrying the `__pendingTargetId` js-debug put in the configuration; that id is the only thing pairing the new connection with the target the adapter is holding. `dapDebugServer.js` branches on exactly that field.

So `dap_connect` exists beside `dap_start` ([[component_dap_host]]), and the frontend keeps a parent/child tree rather than a list ([[component_debug_session_tree]]).

What the shape forbids:

- **No fixed `threadId`.** It differs per session (0 in a plain launch, 2 in a vitest worker), so it always comes from the `stopped` event.
- **No "the session".** Pause is sent to `leafSessions()`, because the root never stops and the leaves are where program code runs. Stop and restart act on a root.
- **No single stack.** `debugStops()` is a list of stopped sessions, each with its own frames; a selected frame names a session *and* a frame id.
- **No flat assumption anywhere.** `pnpm vitest` produced four sessions across three levels; `pnpm test` produced **214 sessions across four levels**.
- **Cost scales with the tree.** A breakpoint toggle sends one `setBreakpoints` per session, so 214 of them on that run. Correct, and a known cost.

## Why it's this way

Because the alternative is not a simplification, it is a bug that only appears when somebody debugs something real. A "start simple, add multi-session later" plan would have shipped a debugger that works on a scratch file and dies on the first package script, and the failure mode is silence rather than an error: the child session is where the breakpoint is, so nothing stops and nothing complains.

It also means the tree's depth is not bounded by anything Sway knows. A package manager spawning a runner spawning a worker is three levels before any user code, so the pane indents to a cap rather than nesting boxes.

## Related

- [[component_debug_session_tree]], the code that holds it
- [[component_dap_host]], why one server accepts many connections
- [[concept_pause_snapshot]], the other thing a pause turns out to be
- [[gotcha_js_debug_emits_initialized_more_than_once_per_session]], configure each of them exactly once
- [[lesson_fix_the_kill_threshold_before_measuring]], the spike that found this had its number written first
