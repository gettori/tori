---
summary: debug panel interleaves every session's console output in arrival order tagged by session, not split per session
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/tori, branch `wave-8`); Phases 4, 7-10; epic #69, sub-issues #73/#74/#75; commits d19cf09, a5e1d6c, 4d396a8, 1c1fbf6"
---

# Debug panel: what is running, where it stopped, and what it holds

**Location:** `src/panels/Editor/DebugPanel.tsx`, `src/utils/debugStore.ts`, `debugStack.ts`, `debugVariables.ts`, `debugWatch.ts`, `debugRepl.ts`, `debugAsk.ts`, `watches.ts`, `src/panels/Editor/debugHover.ts`

One `debug` `RightMode` pane holding the whole of a debug run, top to bottom: the session tree, six controls, the call stack, a lazy scope tree, the watch list, an interleaved console and its REPL. Landing the pane and the console **before** the launch code was deliberate, so no phase could pass on silence ([[lesson_the_handshake_succeeded_and_the_feature_is_silent]]).

The Solid-facing stores are split by question rather than by file size: `debugStore.ts` owns "what is running and what has it said", `debugStack.ts` "where is it", `debugVariables.ts` "what does it hold", `debugWatch.ts` + `watches.ts` "what did you ask to keep seeing", `debugRepl.ts` "what did you ask just now", `debugAsk.ts` "how does that read as a question to an agent". None of them import CodeMirror.

## The session tree and the console

The session list is a tree because a debug run is one, flattened into a single indented column so a deep tree scrolls as one list. The console **interleaves every session's output in arrival order**, tagged with the session that produced it: splitting it per session would be tidier and would lose the one thing the interleaving shows, which is what happened before what.

Output is sanitized as text Tori did not author ([[lesson_sanitize_text_you_did_not_author]]), keeping newlines because the transcript is line-oriented. The REPL's own echoes use a `repl` category that is **not** in `SHOWN_CATEGORIES`, so an adapter claiming that category on an `output` event is dropped rather than allowed to forge a prompt.

## The stack

A run pauses **per session**, not per run, so `debugStops()` is a list of stopped sessions each with its own frames, and a selected frame names both. `MAX_FRAMES` is 50. Clicking a frame opens where it is; a frame with no file on disk opens as a read-only synthetic tab ([[concept_synthetic_editor_tabs]]) whose text comes back from a `source` request, because **DAP's rule is that `sourceReference > 0` beats `path`** and js-debug really does send node's own frames as `path: "<node_internals>/…"` *with* a live reference.

Stepping clears the stack on send rather than on the adapter's answer, because a step's own `stopped` can arrive before its `continued`, and a stack left standing in between is a highlight on a line the program has left. A *refused* step puts the stack back.

## Scopes, variables and hover

Lazy: children are fetched on expand, never on stop. A container the adapter reports as long is paged (`VARIABLE_PAGE` 100), asking for the named and indexed halves separately because a `filter: "indexed"` answer has no `length` in it. Measured on a 1000-element array: the first page is 103 rows and the "show more" row counts 900, then 800.

`setVariable` is gated on the capability and **trusts its own response body**, never a re-read, because a scope container is a snapshot of the pause ([[concept_pause_snapshot]]).

Hover-to-inspect is gated **twice**: on the program being paused, and on the hovered file being on the selected stack (`fileOnStack`). A frame's names mean nothing in a file the program is not in, and answering anyway is worse than answering nothing, because the value is real and belongs to a different `count`.

## Watches, and asking an agent

Watches are workspace-keyed, re-read on every frame change and after a `setVariable`, and keyed by **workspace plus expression**: `orders.length` means one thing in one worktree and nothing in another. An expression that stops resolving shows the adapter's message in place of its value and **keeps its row**, because a watch that vanishes when it errors is one nobody can fix.

"Ask the agent" is offered from the selected stack frame and from the variables heading, and both compose the identical message because `frameAsk` reads the stores itself rather than taking them as arguments. Every borrowed string is clipped and every omission is counted; see [[concept_safe_send]].

## Key files & entry points

- `src/panels/Editor/DebugPanel.tsx:91`, the pane
- `src/utils/debugStack.ts:106`, `currentFrame` / `:156` `openFrame` / `:239` `leafSessions`
- `src/utils/debugVariables.ts:212`, `loadMoreVariables` / `:264` `setVariableValue`
- `src/panels/Editor/debugHover.ts`, `debugHover(path)`, publishing the buffer path as a facet so the wiring is assertable
- `src/utils/debugAsk.ts:85`, `composeFrame`

## Connections

- Reads [[component_debug_session_tree]], every store hangs off `onDebugChange`
- Hosted by the `RightMode` union alongside [[component_problems_panel]]
- Writes through [[concept_safe_send]]
- Opens path-less frames via [[concept_synthetic_editor_tabs]]

## Related

- [[concept_pause_snapshot]], why a container is stale and `evaluate` is not
- [[concept_dap_session_tree]], why the stack is a list of stops
- [[lesson_the_handshake_succeeded_and_the_feature_is_silent]], why the pane landed first
- [[lesson_sanitize_text_you_did_not_author]], the console's rule
- [[gotcha_js_debugs_source_name_is_the_absolute_path]]
- [[gotcha_a_dap_scope_reference_is_a_snapshot_of_its_pause]]

## Does NOT

Virtualize the variables tree, coalesce a stack past `MAX_FRAMES`, release fetched sources before the app closes, or show a worker/thread UI beyond what the session tree gives free.
