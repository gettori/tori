---
summary: F5 builds one of three debug configs, and console must stay internalConsole or js-debug loses the session silently
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/sway, branch `wave-8`); Phase 5; epic #69, sub-issue #71; commit 2a77eac"
---

# Debug launch: three target kinds and one config builder

**Location:** `src/utils/debugTargets.ts`, `src/utils/debugLaunch.ts`

What F5 actually starts. `debugTargets.ts` is pure: a `DebugTarget` plus a `TargetContext` (resolved root, directory entries, environment) becomes a `DebugConfig`. `debugLaunch.ts` is the thin async half that resolves the root through `dap_root_for`, reads the entries and the augmented environment, and hands the config to `startDebugSession`.

Three kinds, and no fourth: **the active file**, **a `package.json` script**, and **attach to a port**. `.vscode/launch.json` is deliberately not parsed.

## What every launch carries, and why

`launchBase` sets `console: "internalConsole"` and `stopOnEntry: true` on launches only.

- **`console: "internalConsole"` keeps the debuggee's stdio on the DAP wire as `output` events.** Phase 1 measured the alternative and it is not a preference: `integratedTerminal` and `externalTerminal` both make js-debug issue `runInTerminal`, and a client that cannot serve it loses the session at **zero stops, zero output and zero errors**, completely silently. It is also declared on `INodeLaunchConfiguration` alone, so sending it on an attach is a field the adapter has no slot for. See [[gotcha_console_integratedterminal_makes_js_debug_issue_runinterminal]].
- **`stopOnEntry: true` is not a user-facing pause.** `dapSessions` continues straight through it. It exists because a short-lived TypeScript target otherwise runs to completion before js-debug resolves its source map, so the breakpoint never binds. See [[lesson_when_config_changes_nothing_it_is_a_race]].
- **The package runner comes from the lockfile**, reusing `tasks.ts`'s rule rather than a second copy: `npm run dev` in a pnpm repo is not a preference somebody got wrong, it is a command that installs the wrong tree. See [[gotcha_npm_cannot_graft_onto_this_pnpm_tree]].
- **An attach config carries none of the launch fields.** Sway did not start the process, so it has no environment to hand it and no entry to pause at. The port is remembered per workspace, following [[concept_path_keyed_workspace_stores]].
- **`env` carries the augmented PATH**, because a GUI-launched Sway inherits a minimal one and `pnpm` is not on it ([[gotcha_gui_launched_processes_inherit_a_minimal_path]]). Phase 1 confirmed js-debug resolves `node` and `pnpm` from exactly the PATH it is handed.

## Measured, all three kinds against the real bundle

Closing pass of the wave, only the Rust transport stubbed:

| target | stopped on a breakpoint | time to pause | sessions |
|---|---|---|---|
| active file (`vars.ts:6`) | yes | 415 ms | 2 |
| package script (`script.mjs:3`) | yes | 616 ms | 3 |
| attach (`--inspect=9230`, `server.mjs:3`) | yes | 2281 ms | 2 |

## Key files & entry points

- `src/utils/debugTargets.ts:77`, `fileConfig` / `:88` `scriptConfig` / `:105` `attachConfig`
- `src/utils/debugTargets.ts:116`, `configFor`, the one switch over the three kinds
- `src/utils/debugTargets.ts:131`, `anchorFor`: a script and an attach have no file of their own
- `src/utils/debugLaunch.ts:59`, `launchTarget`

## Connections

- Depends on [[component_dap_host]], `dap_root_for`, `dap_launch_env`
- Starts [[component_debug_session_tree]]
- Reuses [[component_task_runner]]'s lockfile-to-runner rule
- Surfaced by [[component_debug_panel]] and the command palette ([[concept_command_registry]])

## Related

- [[lesson_when_config_changes_nothing_it_is_a_race]], why `stopOnEntry` and not `outFiles`
- [[concept_path_keyed_workspace_stores]], the remembered attach port and last target
- [[gotcha_console_integratedterminal_makes_js_debug_issue_runinterminal]]

## Does NOT

Parse `.vscode/launch.json`, target a browser, debug over SSH, or start anything without a resolved root.
