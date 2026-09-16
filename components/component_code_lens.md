---
summary: code lens draws reference and implementation counts above lines, off by default until a workspace configuration is sent
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/sway, branch `wave-7`); Phase 9 (commit d7a6e3e); issue #68"
---

# Code lens: counts above the line, behind a setting

**Location:** `src/panels/Editor/lspCodeLens.ts`, `src/panels/Editor/codeLensWidget.ts`, `src-tauri/lsp/typescript.toml`

Reference and implementation counts drawn as block widgets above the lines they describe, off by default. It is the only language feature in Sway that is not an answer to a question the user asked: nobody puts the caret anywhere to get "3 references". That makes it the only one whose cost is paid whether or not anybody reads it, which is the entire reason for the setting and for where the gate sits.

## Responsibilities

- Ask `textDocument/codeLens`, resolve the lenses that arrive titleless, and publish the result under a latest-wins guard.
- Render one strip per line, several lenses on a line merged into one widget.
- Reach every buffer when the setting changes, background ones included.
- Does **not** make a lens clickable: the commands servers attach are client-side (`editor.action.showReferences`), not things `workspace/executeCommand` can run. Does **not** resolve by viewport; that needs the view, which the protocol half deliberately does not have.

## Key files & entry points

- `lspCodeLens.ts:34` — `codeLensClientCapabilities`: `textDocument.codeLens: {}` plus `workspace.codeLens.refreshSupport`, which is a promise rather than a preference and ships with its router entry (see [[concept_server_request_router]]).
- `lspCodeLens.ts:54` — `MAX_CODE_LENSES = 100`, bounded because the resolve is per lens.
- `lspCodeLens.ts` — `requestCodeLenses` (ready → provider → **sync** → request → resolve → drop the still-untitled), and `refreshCodeLenses(deps, path)` with two guards that do not cover each other: a token keyed on path for out-of-order replies about *this* file, and a second look at `deps.current` for a reply about a file that has since left the screen.
- `codeLensWidget.ts` — `codeLensDecorations` anchoring at the line's **start** with `side: -1` (where [[component_peek_view]] anchors at a line's end with `side: 1` to sit below), the field mapping through changes, and `codeLensExtension(on)` for the compartment.
- `CodeEditor.tsx` — a per-buffer `codeLens` compartment, `syncCodeLens` through `reconfigureBuffers`, and the setting gate in `refreshLenses`.
- `src-tauri/lsp/typescript.toml` — the `[settings]` table without which the whole feature draws nothing (below).

## Connections

- Answers `workspace/codeLens/refresh` through [[concept_server_request_router]], root-filtered like the semantic one.
- Its fourth home is [[concept_workspace_settings_overlay]]'s: `codeLens` lands in the type, `settingsCatalog`, `settings.rs` and **both** schema files.
- Reconfigured through `lspReattach.ts`'s `reconfigureBuffers`, which is what reaches buffers in no view.
- Hosted by [[component_cm6_editor]]; the toggle lives in [[component_settings_store]]'s Editor section.

## Two requests, and the second is the expensive one

`textDocument/codeLens` answers *where* the lenses go, cheaply, because a server can decide that from the syntax tree; a lens with no `command` then needs `codeLens/resolve` to find out what it says, which is where the reference counting actually happens. So the resolve is the feature rather than an optimisation to skip, and it is gated on `resolveProvider`, since `codeLensProvider: {}` says "I place lenses", not "I can resolve them". A still-untitled lens is dropped rather than drawn: a block widget with no content is a strip of vertical space the user cannot delete and nothing explains.

## The setting drew nothing until the server was told to produce any

`typescript-language-server` 4.4.1 advertises `codeLensProvider: { resolveProvider: true }` **unconditionally**, but both providers check the *workspace configuration* before producing anything (`cli.mjs:21364`), and a preference nobody sent reads as off. Measured both ways on a file with three exported symbols: no `[settings]` table, **0 lenses**; with one, **3**. The preference is read out of the workspace configuration, not `initialization_options` (`getWorkspacePreferencesForFile`, `cli.mjs:21129`), which is what it looks like it should be. Enabling it costs nothing while Sway's setting is off, because the expense is in the request and Sway does not make one.

`showOnAllFunctions` is deliberately not set: on, every inner helper gets a lens and most read "0 references".

**rust-analyzer is unverified** (not on the machine this was built on), so `rust.toml` was left alone rather than configured on a guess.

## Related

- [[lesson_the_handshake_succeeded_and_the_feature_is_silent]] — the failure this is the third instance of
- [[concept_workspace_settings_overlay]] — the four homes a new editor setting has
- [[component_code_actions]] — the other surface gated on an advertised provider
- [[gotcha_typescript_language_server_answers_no_code_lenses_until_a_workspace_configuration_enables_them]]
- [[gotcha_codemirror_decoration_precedence_nests_inward]] — the neighbouring decoration rule
