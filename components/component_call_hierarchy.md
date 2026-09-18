---
summary: the Calls tab has no tree request, so each level costs a round trip, and rooting waits until the panel is visible
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/tori, branch `wave-7`); Phase 8 (commit a1511d7); issue #67"
---

# Call hierarchy: the Calls tab, one level per round trip

**Location:** `src/utils/callHierarchy.ts`, `src/panels/Editor/lspCallHierarchy.ts`, `src/panels/Editor/CallsPanel.tsx`

A right-panel mode, sibling of Problems and Outline, showing who calls the symbol under the caret and what it calls. Built on the same three-module split as [[component_editor_symbols]]: a CodeMirror-free store in `utils/`, the live-client half in `panels/Editor/`, and the panel. The split is not a style choice here either — `Editor.tsx` reads the store to decide whether the tab exists at all, and it sits on the eager side of the lazy `CodeEditor` boundary, so one runtime `@codemirror/*` import in `utils/` puts the editor's ~1.3 MB graph back in the startup chunk.

## Responsibilities

- Turn a caret position into a root item, and walk one level from an item in either direction.
- Own the three-state store that decides whether the tab is visible.
- Render the tree with per-row lazy expansion, a direction toggle, and a cycle guard.
- Does **not** fetch a depth, cache across a re-root, or own the tab's placement (that is `Editor.tsx`'s `RIGHT_MODE_TABS`).

## Key files & entry points

- `utils/callHierarchy.ts:65` — `callHierarchyClientCapabilities`, deliberately `callHierarchy: {}`: the spec's only field there is the `dynamicRegistration` this client must not advertise, since it answers server-initiated registration with `-32601`.
- `utils/callHierarchy.ts:31` — `CallItem`, with `raw: unknown` kept verbatim.
- `utils/callHierarchy.ts:54` — `MAX_CALLS_PER_LEVEL = 500`, bounded per level rather than per tree, because the depth is the user's choice and the width is not.
- `utils/callHierarchy.ts:82` — a private `pathOf` duplicating `uriToPath`, because importing `toriWorkspace` would pull CodeMirror into the eager bundle. A test compares the two across spaces, non-ASCII and a literal `%`, so they cannot drift into disagreeing about escaping.
- `utils/callHierarchy.ts:224` — `callKey`, position-based rather than name-based: two overloads share a name, and a recursive pair is only a cycle if it returns to the same *place*.
- `lspCallHierarchy.ts` — `prepareCallHierarchy` (ready → provider → **sync** → request), `callLevel` (**no sync**), `rootCallHierarchy` with a latest-wins token keyed on path, and `noteCallSupport`.
- `CallsPanel.tsx` — expansion keyed on the **ancestor chain** (`${prefix}>${key}`), an in-flight guard, and a cycle row rendered with no disclosure control.

## Connections

- Mirrors [[component_editor_symbols]] exactly: same three states, same lazy-boundary split, same store shape.
- Hosted as a right-panel mode by [[component_cm6_editor]] (`Editor.tsx`'s `RightMode` union, `modeAvailable`, and the bail-out effect).
- Reaches the client through [[component_lsp_host]]'s `lspTargetFor`; the fetcher is registered by the mounted editor for the reason `setWorkspaceSymbolSearch` is.

## Three things the protocol forces

**There is no "give me the tree" request.** `textDocument/prepareCallHierarchy` turns a *position* into an item, and each of `incomingCalls`/`outgoingCalls` walks exactly one level from an item. That is why the panel expands lazily rather than choosing a depth: every level is a round trip, and a server that indexes on demand will spend real time on a level nobody looked at.

**The server's own item is handed back verbatim.** The spec's round trip is "the item you gave me", and a server may hang private `data` on it; a rebuilt item drops that and the level comes back empty with nothing on the wire to explain it.

**`from` versus `to` is the whole difference between the directions**, and reading the wrong field yields an empty level rather than an error: a tree that silently never expands. The direction is a parameter to the normaliser rather than something the caller unwraps and hopes about.

## Why the tab's visibility costs no request

Rooting originally fired on every caret settle for any file whose server supported call hierarchy, panel open or not, doubling the per-caret LSP traffic the code-action bulb already generates. The two questions are now split: `noteCallSupport` decides the tab from `callHierarchyProvider`, which is already in the `initialize` reply and costs nothing, and the prepare happens only while the panel is on screen (`callsVisible`, passed down from `Editor.tsx`, the only thing that knows). Opening the panel roots immediately rather than waiting for the next caret move.

## Related

- [[component_editor_symbols]] — the page this one is modelled on
- [[component_peek_view]] — the other "where else does this appear" surface
- [[concept_lsp_capability_contract]] — why the empty capability object still has to be sent
- [[gotcha_autosync_is_debounced_so_sync_before_a_position_request]] — why the prepare syncs and the level does not
