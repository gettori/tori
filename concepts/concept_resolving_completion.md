---
summary: toriCompletion() replaces lsp-client's completion source to fire additionalTextEdits as a second transaction at 2s
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/tori, branch `wave-7`); Phase 4 (commit bd8158a); `src/panels/Editor/lspCompletion.ts`, `lspClient.ts:346-393`"
---

# Auto-import means replacing the library's completion source, not wrapping it

tsserver puts auto-import edits in `completionItem/resolve`, and `@codemirror/lsp-client` never sends that request: it applies `additionalTextEdits` from the *initial* item only (`dist/index.js:969-978`). There is no hook to add. The library builds each option's `apply` while mapping the reply, and CodeMirror's `apply` is **synchronous**, so there is nowhere to await a resolve between the pick and the commit. The only way in is to replace `serverCompletion()` with Tori's own source, which means the client's extension list has to be **written out by hand** instead of spread from `languageServerExtensions()`. That hand-written list is now a permanent constraint on this file, and it is why `clientExtensions()` is exported so tests build the client the app builds.

## How it works

`toriCompletion()` re-implements `serverCompletionSource` with one addition: after the identifier is inserted, the item is resolved and any `additionalTextEdits` that come back are dispatched as a **second transaction**. Insertion never waits on the server, so a refused, slow or unsupported resolve costs the import line and nothing else. The round trip is bounded at **2 s** (not `request_timeout_ms`, which is 20 s/90 s and also covers `initialize`): an edit landing a minute later does not read as a late auto-import, it reads as the editor typing by itself into wherever the caret has moved on to. On expiry the request is cancelled with `$/cancelRequest` rather than merely abandoned.

`completionItem.resolveSupport` is declared for `additionalTextEdits` **only**, so nothing licenses the server to withhold documentation Tori never resolves.

**The ordering inside the resolve is the whole correctness story**, and all three parts were confirmed by breaking them and watching a named test fail:

1. **`sync()` first**, so the server computes the import against a document that already holds the identifier. Without it tsserver answers from the half-typed text and can decide no import is needed at all.
2. **The `WorkspaceMapping` is taken *after* the sync**, so `getMapping` composes in whatever is typed while the request is out.
3. **`LSPPlugin.get(view) !== plugin` before dispatching.** One `EditorView` is reconfigured per tab, so a resolve for `a.ts` landing after a swap would put an import into `b.ts`.

All-or-nothing came free: `mapPosition` throws for a line the document does not have, and one `dispatch` for the whole set means CodeMirror refuses an invalid range before applying any of it.

## Why it's this way

**A snippet item carrying `additionalTextEdits` lost them twice over.** The library's snippet branch wins outright and never reads them, and `worthResolving` declined an item that already had edits, so both mechanisms said no and the import silently never landed. `applySnippetWithEdits` fixes it: `snippet()` dispatches for itself, so the carried positions clear its insertion by a single length delta (one contiguous replacement of `[from, to)`), and an edit landing *inside* what the snippet replaced is dropped rather than placed. `ExtraEdit` carries a `rebuild` closure rather than raw edits, so remapping a snippet option under an open popup cannot quietly turn it into a plain insertion.

**The wrapper was dropping the `pickedCompletion` annotation**, which is added *around* `insertCompletionText` rather than inside it. Nothing reads it while `activateOnCompletion` stays at its default, which is exactly why the loss would have gone unnoticed.

**And writing the list out by hand revealed that the library's keymap had never been bound at all.** `keymap.of(...)` returns a bare `FacetProvider`, and the client keeps a configured extension only if it is an array or carries `.extension` (`dist/index.js:551`). Spread as a top-level entry the whole keymap was dropped on the floor, so F12, ⇧F12, F2 and ⇧⌥F were never bound by it, while `commands.ts` advertised three of them as `sub:` labels. Wrapping it in an array binds it, but only `jumpToDefinitionKeymap` and `findReferencesKeymap`: the library's ⇧⌥F would take the chord from Tori's `lsp-format` (which tries the project's Biome or Prettier first, and would then swallow ⇧⌥F in stylesheets and Markdown too), and its F2 runs the `renameSymbol` whose `doRename` skips unopened files silently.

## Related

- [[concept_lsp_capability_contract]] — why the hand-written list is verified against a captured baseline rather than trusted
- [[concept_lsp_workspace_bridge]] — where the mapping comes from and why its snapshot moment matters
- [[component_cm6_editor]] — the pane that owns the client and its extension list
- [[gotcha_a_bare_keymap_facetprovider_is_dropped_by_lsp_client]] — the trap that hid four bindings
- [[gotcha_workspacemapping_snapshots_startdocs_at_construction]] — why the mapping is taken after the sync
