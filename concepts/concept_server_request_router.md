---
summary: serverRequests.ts intercepts server LSP requests on the transport, since receiveMessage answers the rest with -32601
status: current
updated: 2026-08-11
source: "Editor wave 7: language intelligence depth (personal/tori, branch `wave-7`); Phase 1 (commits c4750d7, cec4058), extended by Phases 5, 8, 9 (a620384, a1511d7, d7a6e3e); `src/panels/Editor/serverRequests.ts`, `lspClient.ts:410-500`, `serverEdits.ts`, `lspConfiguration.ts`, contrasted by Editor wave 8: the debugger (DAP) (branch `wave-8`), Phase 3; `src/utils/dapClient.ts:45`"
---

# The server-request router: answering what a language server asks back

LSP is bidirectional, and `@codemirror/lsp-client` only travels one way. `LSPClient.receiveMessage` answers **every** server-initiated request with `-32601 MethodNotFound` (`lsp-client/dist/index.js:684-690`) and offers an extension point for notifications only. So a request Tori owes an answer to cannot be handled inside the library at all: it has to be intercepted on the **transport**, before the library ever sees the frame. `serverRequests.ts` is that seam, and it is a router keyed by method rather than a chain of hand-rolled interceptors, because every capability declared from here on owes an answer on the same seam and the second hand-rolled interceptor is where the rules below quietly stop being followed.

## How it works

`createRequestRouter<Ctx>(handlers)` returns a function the transport calls for every inbound frame, returning whether the frame was consumed. A handler returns a value to answer `result`, a promise to answer when it settles, or nothing to answer `null`; throwing answers a JSON-RPC error, so no handler builds a frame itself.

Four requests are answered today, all registered in `lspClient.ts`:

- `workspace/semanticTokens/refresh` and `workspace/codeLens/refresh` — forwarded to the mounted editor through a `refreshSlot()`, one slot each. Both carry the **root** of the session that sent them, because the claim is that session's alone: in a monorepo, `packages/a`'s server going stale says nothing about a file `packages/b` answers for.
- `workspace/applyEdit` — answered non-interactively (see [[concept_workspace_edit_policy]]).
- `workspace/configuration` — a synchronous lookup in the server's own `[settings]` table, which is what makes `yaml-language-server` work at all (see [[concept_schema_backed_json]]).

**Two rules are load-bearing.**

1. **Substring before parse.** `msg.includes(method)` for every registered method runs before `JSON.parse`. Without it every frame from a busy server is parsed twice, once here and once by the library, for messages that arrive a handful of times per session.
2. **A synchronous handler answers synchronously.** The router branches on whether the answer is thenable rather than `await`ing unconditionally. This is not a preference: `lspClient.test.ts:477` asserts the reply is on the wire immediately after `onmessage`, with no `await` in between, and deferring by even one microtask breaks six existing tests.

Only the **request** form is consumed. A notification-shaped frame, or a *response* that merely mentions a method name, falls through: replying to something carrying no id would put `"id": undefined` on the wire.

## Why it's this way

**The router is generic over its context, and that is a correctness property rather than a typing flourish.** The first version of `applyDepsFor` looked its session up with `.find(s => s.handle.root === root)`. Sessions are keyed `(server_id, root)` and both bundled configs list `.git` as a root marker, so a repo where neither `Cargo.toml` nor `tsconfig.json` sits above the file **already** has two sessions on one root, and a server-initiated edit would have been applied through the wrong server's workspace and mapped through the wrong client. Making `Ctx` the whole `LspHandle` is what lets the type system refuse a bare root. Same rule as [[component_lsp_host]]'s session keying, inverted.

**Declaring a capability creates the obligation.** [[concept_lsp_capability_contract]] says advertise only what you answer; this is the other half of it. `workspace.codeLens.refreshSupport` and `workspace.semanticTokens.refreshSupport` are promises that Tori will handle a push, and answering `-32601` to a push the client invited tells a conformant server the client lied. rust-analyzer's response to that is to stop asking, which is precisely the feature. So a refresh capability and its router entry land in the same change, never in sequence.

## The DAP router is the same seam with a different trust model

Wave 8 built the same shape for debug adapters (`REVERSE_REQUESTS` in `dapClient.ts:45`) and had to invert one assumption. Here, a capability the client does not declare is a request that never arrives, so the router's job is to answer the ones it opted into. **js-debug does not read capabilities at all**: `supportsStartDebuggingRequest` and `supportsRunInTerminalRequest` appear nowhere in the bundle, and it issues reverse requests off the *launch config* instead.

So on the DAP side the declaration is not a bound on what arrives, and **all four names get answers from birth** (one real, `startDebugging`, and three explicit refusals), pinned by a constant that `scripts/install-dap.mjs` re-derives structurally from the bundle on every install. That check is what found `remoteFileExists`, which neither the plan nor two adversary passes had. See [[component_debug_session_tree]].

## Related

- [[concept_lsp_capability_contract]] — the declaring half; its "one deliberate exception" became this mechanism
- [[concept_workspace_edit_policy]] — what `workspace/applyEdit` is routed into, and why it may never open a modal
- [[concept_schema_backed_json]] — why `workspace/configuration` had to be answered before the YAML server did anything
- [[component_lsp_host]] — where the router is registered, and the `(server_id, root)` keying it depends on
- [[component_code_lens]] — the most recent capability to arrive with its router entry attached
- [[gotcha_lsp_start_reuses_a_running_session_and_returns_without_wiring_the_new_channel]] — the neighbouring transport trap
- [[component_debug_session_tree]] , the same seam for DAP, and why a capability declaration protects nothing there
