---
summary: quick fixes capture the server's raw diagnostics ahead of CodeMirror's lint state, since tsserver needs the code field
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/tori, branch `wave-7`); Phase 2 (commits 5155ea8, 630d36a), Phase 3 (952c547); issue #64"
---

# Code actions: quick fixes, source actions, and the bulb

**Location:** `src/panels/Editor/` (key files: `lspCodeActions.ts`, `codeActionCommand.ts`, `codeActionGutter.ts`, `lspDiagnosticContext.ts`, `organizeOnSave.ts`, `src/utils/sourceActions.ts`)

Everything a server offers to *do* about a place in a file: quick fixes on the caret's line behind `⌥⏎` and a gutter lightbulb, whole-file source actions (organize imports, remove unused, sort imports) as palette commands and as a save-path step, and the fix titles the Problems panel sends to an agent. The request half asks and normalises; `codeActionCommand.ts` applies through [[concept_workspace_edit_policy]] with a user-facing policy.

## Responsibilities

- Request `textDocument/codeAction` for the caret or selection with the line's **raw** diagnostics as context, resolve lazy actions through `codeAction/resolve`, and run command-only actions through `workspace/executeCommand`.
- Draw a lightbulb on the caret's line only, and reserve no gutter column at all where the server has no `codeActionProvider`.
- Offer source actions **by kind**, gated on what the server advertises in `codeActionKinds`, and run `source.organizeImports` inside the save path ahead of the formatter.
- Answer the Problems panel's "what could be done about this?" through an injected lookup.
- Does **not** own multi-file application: that is `workspaceEdit.ts`. Does **not** invent refactorings; every action offered is one the server advertised.

## Key files & entry points

- `lspCodeActions.ts:52` — `codeActionClientCapabilities`: literal support, kind valueSet, `isPreferredSupport`, `dataSupport`, and `resolveSupport` for `edit` **only**. Declaring `command` too would let a server strip the command from the first reply, leaving an action the menu can neither describe nor run.
- `lspCodeActions.ts` — `CodeAction.raw`, the server's own object, kept so `codeAction/resolve` is handed its own item back verbatim. Resolve is gated on `codeActionProvider.resolveProvider`, since `codeActionProvider: true` says "I do code actions", not "I resolve them".
- `lspDiagnosticContext.ts` — the raw `publishDiagnostics` capture (see below).
- `codeActionCommand.ts` — the apply policy: a backstop refusal, a dirty-buffer confirm, a snapshot before the first write, a multi-file notice.
- `codeActionGutter.ts` — the bulb, marker ranges at `startSide = 1`.
- `organizeOnSave.ts` — `formatOnSave.ts`'s shape plus one extra failure mode, bounded at 2 s.
- `src/utils/sourceActions.ts` — `SOURCE_KINDS`, which lives in `events.ts`'s neighbourhood because `commands.ts` may import only `./events` and `./settingsCatalog`.

## Connections

- Applies through [[concept_workspace_edit_policy]] — same three hooks as rename, different sentences; the four strings are the whole difference, which is why nothing was factored out of `renameAcross`.
- Runs commands through [[component_lsp_host]]'s `executeServerCommand`, whose usual answer is the server pushing a `workspace/applyEdit` straight back, routed by [[concept_server_request_router]].
- Feeds [[component_problems_panel]] through `setDiagnosticFixLookup`, the same injected shape as `setWorkspaceSymbolSearch`, because that panel is on the eager side of the lazy editor boundary.
- Composes its message to an agent through [[concept_safe_send]].
- Hosted by [[component_cm6_editor]]; bindings registered in [[concept_command_registry]] (`⌘⌥A`, `sub: ⌥⏎`).

## Why the raw diagnostic capture exists

`serverDiagnostics()` converts a publish to `{from, to, severity, message}` and throws away `code`, `source` and `data` (`lsp-client/dist/index.js:1827-1834`). tsserver picks quick fixes by `code`. A context rebuilt from CodeMirror's lint state would therefore have asked every conformant server a question it could match nothing against, and quick fixes would come back **empty against a correct server**. So the raw publish is captured off the same notification through an extension registered **ahead of** `languageServerExtensions()`: the client stops at the first handler returning true (`dist/index.js:670-676`), and `serverDiagnostics()` returns true for every publish it renders, so behind it this would see only the files nobody has open. The capture returns false so the squiggles still appear.

## Related

- [[concept_lsp_capability_contract]] — why the capability block and the feature ship together
- [[concept_workspace_edit_policy]] — the applier and its hooks
- [[component_code_lens]] — the other above-the-line surface, and the other one gated on a provider
- [[gotcha_a_cm6_gutter_marker_needs_startside_1_or_the_line_you_just_typed_inherits_its_neighbours_blame]] — why the bulb's markers are at `startSide = 1`
- [[gotcha_a_request_bound_to_a_fast_changing_selection_needs_a_latest_request_wins_guard]] — the guard the bulb needs, keyed on path *and* range
- [[gotcha_autosync_is_debounced_so_sync_before_a_position_request]] — every request here is positional
