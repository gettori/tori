---
summary: Problems lists LSP diagnostics worst file first from a CodeMirror published signal, capped per file at the most severe
status: current
updated: 2026-08-28
source: "Editor upgrades: diff polish, hunk staging, diagnostics (personal/sway, phase 3); `src/utils/diagnostics.ts`, `src/panels/Editor/CodeEditor.tsx` (`publishFrom`)"
---

# Problems panel

**Location:** `src/panels/Editor/ProblemsPanel.tsx`, `src/panels/Editor/ProblemsPanel.module.css`, `src/utils/diagnostics.ts`

The LSP diagnostics of every open file, grouped by file and ordered worst-first, as a right-panel mode alongside Files/Changes ([[component_cm6_editor]]). Each row jumps to the line, or hands the diagnostic to the selected session through [[concept_safe_send]].

## Responsibilities

- **A store the panel can read.** CodeMirror keeps diagnostics inside an `EditorState`, reachable only from the editor view; the Problems list is a sibling surface. `CodeEditor` publishes to a module-level signal (`src/utils/diagnostics.ts`) whenever a `setDiagnosticsEffect` transaction lands — not on every keypress.
- **Offset to line/column, once.** `problemsFromState` converts CodeMirror's absolute document offsets into the 1-based line/column that the editor's goto target and `@file#L<n>` mentions both speak, carrying `endLine` so a multi-line TypeScript error mentions `L12-L14` rather than collapsing to one line. Tested against real CodeMirror (`setDiagnostics` into an `EditorState`), not a mock.
- **Open-tab scoping, by two independent mechanisms.** A language server on a monorepo publishes for far more than the user has open. `serverDiagnostics` bails when a published URI has no live view, and Sway's buffer map drops an `EditorState` when its tab closes (`dropDiagnostics`), so an unopened file never enters the store at all. `clearDiagnostics` runs on project switch.
- **A per-file cap** (`MAX_PER_FILE`, 200) as the second, independent limit. It keeps the **most severe** rather than the first N, then restores document order: a file with 300 warnings before its first error must not hide the error.
- **Ordering that puts the worst first.** `orderFiles` sorts by worst severity, then count, then path; `summarize` produces the per-severity badge counts.
- **Send to agent.** `composeDiagnostic` (the third composer in `safeSend`, after hunk comments and selection mentions) builds `@<file>#L<start>-L<end> <severity>: <message>`, flattening multi-line server messages — a raw newline would submit the prompt on some agents and break the insert-only contract. Routed through `requestSend`, refused on a blocked session exactly like the hunk-comment path.
- **The tab only exists when something is wrong.** `modeAvailable("problems")` is false with an empty store, and the pane falls back to Files when the last diagnostic clears.
- **Inside a Feature it answers for every member at once** (#160). It takes `roots[]` and draws a section per member ([[component_member_section]]), grouped by member then by file, worst-first inside each. The scope filter widened with it: `here()` tests every root rather than `folderPath`, and `problemsHere()` in `Editor.tsx` does the same, so an error in the repo you are not looking at still offers the tab. Nothing outside the roots is listed, because a store this wide cannot tell a Feature's departed member from another workspace.
- **The severity dot is announced.** It carried an `aria-label` on a bare `span`, which axe refuses and assistive tech ignores, so severity was conveyed by colour alone. It is `role="img"` now. The panel had no test file until #160, which is why nothing caught it.

## Key files & entry points

- `src/utils/diagnostics.ts` — `problemsFromState`, `capDiagnostics`, `summarize`, `orderFiles`, `publishDiagnostics`/`dropDiagnostics`/`clearDiagnostics`, the `diagnostics` signal.
- `src/panels/Editor/CodeEditor.tsx` — `publishFrom`, the `setDiagnosticsEffect` update listener, `lintGutter()`.
- `src/utils/safeSend.ts` — `composeDiagnostic`.
- `src/panels/Editor/Editor.tsx` — the `"problems"` right-panel mode, its availability gate (`problemsHere`), and the `roots={treeRoots()}` it passes inside a Feature.
- `src/panels/Editor/ProblemsPanel.test.tsx`, `.stories.tsx` — both added in #160.

## Connections

- Depends on [[concept_safe_send]] — the send action is its third composer, insert-only.
- Fed by [[component_lsp_host]] — diagnostics arrive as `textDocument/publishDiagnostics`.
- Hosted by [[component_cm6_editor]] as the "Problems" right-panel mode; the same store backs the editor's gutter markers.
- Severity colours are their own token family, deliberately not the session-status one — see [[concept_design_token_system]] and [[gotcha_codemirror_lint_ships_hardcoded_colours_the_token_guard_cannot_see]].

## Related

- [[component_changes_panel]] — the sibling right-panel surface, and the other safe-send caller.
