---
summary: setting console to integratedTerminal makes js debug issue runInTerminal, a client with no handler loses the session
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP), Phase 1 spike (personal/tori, branch `wave-8`); `src/utils/debugTargets.ts:63`; commit 2a77eac"
---

# `console: "integratedTerminal"` makes js-debug issue `runInTerminal`

Do NOT set `console` to `integratedTerminal` or `externalTerminal` on a launch config without a real `runInTerminal` handler. Both make js-debug issue that reverse request, and a client that cannot serve it loses the session at **zero stops, zero output and zero errors**. `internalConsole` (or leaving it undefined) yields `startDebugging` only, with stops and output working. It is also declared on `INodeLaunchConfiguration` alone, so sending it on an *attach* config is a field the adapter has no slot for. Why: there is no error to find; the run simply produces nothing and looks like a breakpoint that did not bind.
