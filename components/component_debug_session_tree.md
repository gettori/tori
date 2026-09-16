---
summary: a debug run is a tree from birth, correlation is on request_seq and the failure text lives in body.error.format
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/sway, branch `wave-8`); Phase 3; epic #69, sub-issue #70; commit 1e72ae1"
---

# Debug session tree: the DAP client and the sessions it holds

**Location:** `src/utils/dapClient.ts`, `src/utils/dapSessions.ts`

The protocol half of debugging, and the only part that knows what a DAP frame is. `dapClient.ts` is one connection: sequence correlation, request promises, typed event fan-out, and the reverse-request router. `dapSessions.ts` is the *tree* of those connections, workspace-keyed, plus the handshake that configures each one exactly once. Neither imports CodeMirror or Solid, for `diagnostics.ts`'s reason: Editor imports both eagerly.

## The client

- **Correlation is on `request_seq`, never `seq`.** The response's own `seq` is the *adapter's* counter and is unrelated to the request's. Reading it swaps two answers that arrive out of order, and both look plausible.
- **A failure's text is in `body.error.format`, not `message`.** Measured against js-debug 1.117: a failed response carries **no `message` field at all**. `failureText` (`src/utils/dapClient.ts:176`) reads the body first and fills the `{placeholder}` substitutions the spec puts in that string, leaving an unfilled one as written. See [[lesson_a_wrong_error_path_is_invisible_until_it_fails]].
- **Every reverse request gets an answer.** `REVERSE_REQUESTS` (`:45`) names all four js-debug can send, and a fresh connection refuses each with an explicit error rather than leaving it hanging. One failing event subscriber never starves the next, and a subscriber may unsubscribe from inside its own call.
- **Capability declarations are not a defence here.** js-debug issues reverse requests off the *launch config*, not off what the client claimed, and `supportsStartDebuggingRequest` appears nowhere in the bundle. This is a deliberate divergence from [[concept_lsp_capability_contract]] and [[concept_server_request_router]]: the contract still forbids declaring what is not served, but the router cannot rely on the declaration to bound what arrives.

## The tree

**Multi-session is the base case, not the `npm run dev` case.** Phase 1 measured a bare single-file `node fixture.js` producing a root plus a child, `pnpm vitest` producing four sessions across three levels, and `pnpm test` producing **214 sessions across four levels**. The root session never stops. See [[concept_dap_session_tree]].

- `startDebugSession` (`src/utils/dapSessions.ts:145`) starts the root; the `startDebugging` reverse request opens a second connection through `dap_connect` carrying the **`__pendingTargetId`** js-debug put in the configuration, which is the only thing pairing that connection with the target the adapter is waiting on.
- **`configureOnce` (`:298`) is load-bearing.** js-debug emits `initialized` repeatedly, and a second configuration pass re-sends `setBreakpoints`, which *replaces* that file's set, and at that moment js-debug answers `[]`, silently wiping what the first pass registered. The symptom is a breakpoint that never fires, with no error anywhere. See [[gotcha_js_debug_emits_initialized_more_than_once_per_session]].
- **Handshake order:** `initialize`, then `launch`/`attach` **not awaited**, then on `initialized` a `setBreakpoints` per file, then `configurationDone`, then await the launch response.
- **Starts are serialized per adapter id and guarded by a generation counter**, both lifted from [[component_lsp_host]]: two concurrent starts must produce one session, and a start still in flight when the project switches stops itself by handle.
- `leafSessions()` in `debugStack.ts` is what anything addressed at "the program" rather than at a frame has to pick from.

## Key files & entry points

- `src/utils/dapClient.ts:45`, `REVERSE_REQUESTS`, enforced against the bundle by `install-dap.mjs`
- `src/utils/dapClient.ts:176`, `failureText`
- `src/utils/dapClient.ts:207`, `createDapConnection`
- `src/utils/dapSessions.ts:145`, `startDebugSession`
- `src/utils/dapSessions.ts:298`, `configureOnce`

## Connections

- Depends on [[component_dap_host]], every frame rides `dap_send` / the per-session `Channel`
- Used by [[component_debug_panel]], [[component_debug_breakpoints]], [[component_debug_launch]]
- Diverges from [[concept_server_request_router]] and [[concept_lsp_capability_contract]], same seam, different trust model

## Related

- [[concept_dap_session_tree]], the shape and what it forbids assuming
- [[concept_pause_snapshot]], why every reply carries a generation
- [[gotcha_js_debug_sends_no_message_on_a_failed_response]]
- [[gotcha_js_debug_emits_initialized_more_than_once_per_session]]

## Does NOT

Import CodeMirror or Solid, own any UI state, decide what to launch, or assume a flat parent-plus-children shape or a fixed `threadId`.
