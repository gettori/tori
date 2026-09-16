---
summary: one normalised symbol tree feeds the Outline tab, the palette's @ mode and breadcrumbs, rebuilt by range containment
status: current
updated: 2026-08-08
source: "Editor wave 4: language intelligence foundations (personal/sway, branch `wave-4`); Phase 5; commit cbc5b0a; `src/utils/symbols.ts`, `src/panels/Editor/lspSymbols.ts`, `OutlinePanel.tsx`, `src/components/QuickOpen/QuickOpen.tsx`, the split below generalised by Editor wave 7 (branch `wave-7`); Phases 8-9; commits a1511d7, d7a6e3e"
---

# Editor symbols: one tree, three surfaces

`textDocument/documentSymbol` is the answer behind the Outline tab, the palette's `@` mode, and (later) wave 6's breadcrumbs and sticky scroll. All three read **one** normalised tree, published by the editor.

## Two response shapes, one tree

A server answers in either of two shapes, and which one it picks is not something a panel should have to know:

- **hierarchical** `DocumentSymbol[]` — already a tree, each node carrying a full `range` plus the narrower `selectionRange` that is the name itself;
- **flat** `SymbolInformation[]` — one list with a `containerName` string and no nesting at all.

**The flat shape is rebuilt by range containment, not by `containerName`.** Two overloads share a name, and a name is not a position; containment cannot put a method under the wrong class. A test with two classes both holding a `go` pins it.

`workspace/symbol` is always flat and always scoped to one server's root, so a monorepo's package session cannot see its sibling. Every live session is asked and the results merged, de-duplicated by **path and position, never by URI** — two servers need not spell the same file the same way ([[concept_lsp_workspace_bridge]]).

## The split is on the lazy boundary, not on taste

`diagnostics.ts` opens with a rule: a module `Editor.tsx` imports **eagerly** may not touch CodeMirror at runtime, or the whole ~1.3 MB editor graph re-enters the startup chunk. `Editor.tsx` has to read symbol support to decide whether the Outline tab exists at all. So:

- `src/utils/symbols.ts` — types, normalising, the store. CodeMirror-free.
- `src/panels/Editor/lspSymbols.ts` — the asking. Holds a client.

That constraint forces the rest of the design rather than being a preference: **the editor publishes and every symbol surface reads**, exactly the [[component_editor_stores|diagnostics]] arrangement. The outline panel and the palette are siblings of the editor and neither can hold a client.

`workspace/symbol` is the exception, because there is nothing to cache — the query is the user's keystrokes. It reaches the sessions through a **registered accessor** (`setWorkspaceSymbolSearch`), the same shape as `liveBuffers.setBufferAccess`. Empty when no editor is mounted, which is the honest answer: no server is running to ask.

**This shape is now the pattern for any surface whose existence `Editor.tsx` decides**, and wave 7 built two more on it verbatim: [[component_call_hierarchy]] (`utils/callHierarchy.ts` + `lspCallHierarchy.ts` + `CallsPanel.tsx`, with a registered `setCallFetcher` for lazy level expansion) and the fix lookup [[component_problems_panel]] reads through `setDiagnosticFixLookup`. The three-state store — absent means "not asked", `null` means "this server has no provider", an array **including an empty one** means "asked, and it does" — is copied one for one, because collapsing `null` and `[]` would make "this language cannot do this" and "point at something" the same message.

The duplication the rule forces is real and deliberate: `utils/callHierarchy.ts` carries its own copy of `uriToPath` rather than importing `swayWorkspace`. A test compares the two across spaces, non-ASCII and a literal `%`, so the copies cannot drift into disagreeing about escaping.

## Three states, not two

| store value | meaning | Outline tab |
|---|---|---|
| absent key | not asked yet | hidden |
| `null` | the server offers no provider | hidden |
| `[]` | asked, and this file has no symbols | **shown**, saying so |

Only the middle one is a refusal. A file whose server answers with an empty list still gets the tab; hiding on "no symbols" would make an empty file look unsupported. Hiding on the absent key is what stops the tab flickering into existence while a server starts.

## Freshness

- **`sync()` before the request.** `autoSync` is debounced 500 ms, and a symbol reply is a set of positions: asked inside that window, every line number in it is wrong by however much was typed ([[gotcha_autosync_is_debounced_so_sync_before_a_position_request]]).
- **Newest-wins, keyed by path, with the publish inside the guard.** Three things re-ask (tab swap, client lifecycle, the typing debounce) and a busy server can answer out of order. An older reply landing last is not a stale outline the user can ignore — the outline looks right and every row jumps to the wrong line. Publishing lives in `refreshDocumentSymbols` precisely so there is no way to ask without going through the guard.
- **`MAX_SYMBOLS` caps the node count depth-first, not the response array.** One root with a hundred thousand children is a single array entry and would otherwise pass straight through.

## Related

- [[component_lsp_host]] — the sessions asked, and the capability block that makes a server offer the provider at all.
- [[concept_lsp_capability_contract]] — why advertising it was necessary.
- [[component_editor_stores]] — the store pattern this follows.
- [[component_cm6_editor]] — the Outline tab and the palette modes.
- [[component_command_palette]] · [[component_problems_panel]] — the sibling surfaces.
- [[component_call_hierarchy]] — the wave-7 surface built on this page's split, store shape and three states.
- [[lesson_a_guard_keyed_on_what_changed_is_inert]] — the sharper form of the newest-wins rule above.
