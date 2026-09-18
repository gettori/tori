---
summary: advertise only LSP capabilities you answer, since unhandled requests get -32601 and a conformant server stops asking
status: current
updated: 2026-08-11
source: "Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phase 5 (commit cbc5b0a), Phase 7 (commit 075b5d7); `src/utils/symbols.ts`, `src/utils/semanticTokens.ts`, `src/panels/Editor/lspClient.ts`, extended by Editor wave 7: language intelligence depth (branch `wave-7`); Phases 1-9 (c4750d7 -> d7a6e3e), contrasted by Editor wave 8: the debugger (DAP) (branch `wave-8`), Phases 3, 8"
---

# Client capabilities are a contract, not a wish list

Two rules govern what Tori tells a language server it can do, and they pull in opposite directions:

1. **A conformant server offers no provider for something the client never asked for.** `@codemirror/lsp-client`'s `clientCapabilities` const advertises completion, hover, formatting, rename, signatureHelp, definition and friends, references, diagnostics and `window.showMessage` — **and nothing else**. Document symbols, workspace symbols and semantic tokens are all absent, so against a *correct* server those features are simply empty until Tori adds them. That is the hardest kind of wrong to notice, because nothing errors.

2. **Anything you advertise, you must answer.** `LSPClient.receiveMessage` replies to every server-initiated **request** with `-32601 MethodNotFound` (`dist/index.js:684-690`) and exposes an extension point for *notifications* only. A `-32601` is not fatal, but it tells a conformant server the client lied in its capabilities, and a server's reasonable response is to stop asking.

So the surface is grown deliberately and minimally, one block per feature, through `LSPClientExtension.clientCapabilities` entries the library deep-merges.

## What follows from it

- **`didChangeWatchedFiles.dynamicRegistration` stays absent, permanently.** It invites server-initiated registration nothing here answers, and its absence is also what keeps servers doing their own file watching, which is what Tori wants.

- **`workspace.semanticTokens.refreshSupport` was the first deliberate exception**, and it is only defensible because the request *is* answered. Semantic colour is a property of the resolved program: editing `types.ts` changes what a name in `main.ts` means without changing a character of it, and the refresh notification is the only way a server can say so. Nothing the editor can observe locally would ever prompt the re-request.

- **Wave 7 turned that exception into a mechanism, and there are now four.** `workspace.applyEdit`, `workspace.configuration` (which the YAML server *requires*, since it pulls its settings back rather than accepting a push) and `workspace.codeLens.refreshSupport` joined it, so the interception is no longer a special case in the channel handler but a router keyed by method — see [[concept_server_request_router]] for the seam and its two load-bearing rules. `workspace.configuration` moving from "permanently absent" to "declared and answered" is the clearest illustration of the rule: it was refused while nothing could answer it, and admitted the moment something could.

- **A capability block and its handler ship in the same change, never in sequence.** Declaring `refreshSupport` and then answering `-32601` is worse than not declaring it, because a conformant server reads it as a lie and stops asking.

- **`dynamicRegistration` is refused everywhere**, which is why `textDocument.callHierarchy` and `textDocument.codeLens` are sent as literally `{}`: the spec's only field in each is the one this client must not advertise. An empty object is still not nothing — a conformant server offers no provider to a client that never asked at all.

- **And a capability that says yes is not a promise of an answer.** Three wave-7 features handshook correctly and produced nothing, each for a different reason. See [[lesson_the_handshake_succeeded_and_the_feature_is_silent]]; the short version is that this page's rules are necessary and not sufficient.

- **Spread, do not nest.** `languageServerExtensions()` is itself a list of `LSPClientExtension`s, one of which (`serverDiagnostics`) carries capabilities of its own. Passing it as a single element compiles, and silently drops that block. `tsc` caught this; the test suite did not.

- **The list is now written out by hand**, because auto-import had to replace `serverCompletion()` rather than wrap it ([[concept_resolving_completion]]). A hand-written list is one entry away from silently un-advertising a feature, so `clientExtensions()` is exported and a test rebuilds the *old* list, strips the completion block from both, and asserts deep equality — the delta stays the completion change rather than drifting into a record of everything since. That same hand-writing is how the library's keymap turned out never to have been bound at all ([[gotcha_a_bare_keymap_facetprovider_is_dropped_by_lsp_client]]).

- **The merge is deep, and the test proves it against the real client.** `mergeCapabilities` recurses, but a shallow merge would drop the library's entire `textDocument` block the moment Tori adds a key to it — taking hover, completion, rename and references with it. The assertion connects a real `LSPClient` over a fake transport and reads the `initialize` frame that actually goes out, because a hand-rolled copy of the merge would pass while the real one did not.

## Reading an answer back

`supports(capability)` is enough for a provider that answers yes or no. It is **not** enough for `semanticTokensProvider`, which carries the *legend* naming what each token index means — a token stream read without it is a list of integers. So `LspTarget` exposes `capability(name)` beside it, returning the raw advertised value and nothing more. The target stays narrow on purpose: root, `ready`, `supports`, `capability`, `sync`, `request`. A caller holding the `LSPClient` itself could reconfigure or disconnect the session.

`ready` resolves when `initialize` has been answered and settles either way. A file opened as its server comes up arrives before any capability exists, and refusing then would make the feature depend on how fast the server started.

## Where the DAP side diverges, deliberately

The first rule survives unchanged: wave 8 held `supportsVariablePaging` back through five phases and declared it only once `debugVariables.ts` actually sent `start` and `count`, and a test asserts the claim tracks the code. The **second** rule does not carry over. Declaring a capability here is what makes a server send the matching request; declaring one to js-debug does nothing at all, because it reads the launch config instead. A DAP client therefore cannot use its own declarations as a bound on what it will be asked. See [[concept_server_request_router]] and [[component_debug_session_tree]].

## Related

- [[component_lsp_host]] — where the extensions are assembled and the transport lives.
- [[concept_server_request_router]] — the answering half, once the exception became a mechanism.
- [[concept_semantic_token_layering]] — the feature whose capability block earned the first exception.
- [[component_editor_symbols]] — the other block added in wave 4.
- [[concept_lsp_workspace_bridge]] — the other half of talking to a server correctly.
- [[concept_resolving_completion]] — why the extension list is hand-written, and what that cost.
- [[lesson_the_handshake_succeeded_and_the_feature_is_silent]] — why these rules are necessary and not sufficient.
- [[gotcha_autosync_is_debounced_so_sync_before_a_position_request]]
- [[component_debug_session_tree]] , the same contract under an adapter that does not read it
