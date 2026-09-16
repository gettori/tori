---
summary: peek view shows a definition in a block widget the editor never registers, invisible to the language workspace
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth (personal/sway, branch `wave-7`); Phase 7 (commit a862bbe); issue #66"
---

# Peek view: a definition shown without going there

**Location:** `src/panels/Editor/` (key files: `peekLocations.ts`, `peekView.ts`, `peekCommand.ts`)

A CM6 **block widget** hosting a read-only nested `EditorView` of a target range, opened on `⌘⌥P` / `⌥F12` from the caret. The definition variant shows one place; the references variant lists every hit and renders the chosen one in the same widget. The peeked file is deliberately unknown to [[concept_lsp_workspace_bridge]]'s `SwayWorkspace`: peeking opens no tab, registers no file, and leaves the workspace's `files` and `openFile` bookkeeping untouched.

## Responsibilities

- Decide who to ask, what a refusal means, and which reply is still current (`peekLocations.ts`).
- Render the widget and own its state and keymap (`peekView.ts`).
- The three-step open, and choosing a result inside an open peek (`peekCommand.ts`).
- Does **not** register the peeked file with the language workspace, open a tab, or ask `displayFile` for its text. A structural scan in the tests refuses `.displayFile(`, `.requestOpen(`, `.openFile(` and `new SwayWorkspace` in all three modules, matched as *calls* because these files discuss the workspace's bookkeeping in prose precisely to explain why they do not touch it.

## Key files & entry points

- `peekLocations.ts` — `normalizeLocations` handles all three reply shapes (`Location`, `Location[]`, `LocationLink[]`); `peekSourceText` resolves buffer-before-disk through `liveBufferText` then `fs_read_file`; `claimPeek()` is the latest-wins counter; `peekAt` does ready → provider → `sync()` → request → publish inside the guard.
- `peekView.ts` — `PEEK_CONTEXT_BEFORE = 2`, `PEEK_MAX_LINES = 14`, the pure `peekWindow`, `showPeek`/`hidePeek` effects, `PeekWidget`, and `peekField(onSelect)` anchoring at `line.to` with `side: 1` so the panel sits **below** the line it was opened from.
- `peekCommand.ts` — `openPeek(view, kind, path)` and `selectPeekResult`, both answering to the same claim.
- `CodeEditor.tsx` — the field, `peekFromCaret`, the `Alt-F12` binding, and `peek, peekKeymap(peek), peekTheme` at ordinary precedence.

## Connections

- Reads through [[concept_lsp_workspace_bridge]]'s buffer-before-disk rule without using its bridge: peeking into a dirty background tab shows that tab's unsaved text and the disk is not read at all (asserted, not merely preferred).
- Hosted by [[component_cm6_editor]]; bound through [[concept_command_registry]] (`⌘⌥P`, `sub: ⌥F12`).
- Sibling of [[component_call_hierarchy]] — both answer "where else does this appear", one inline and one as a tree.

## Two decisions worth keeping

**Esc is at ordinary precedence, not `Prec.highest`.** With vim on and the *outer* editor focused, Esc belongs to vim: leaving insert mode is the commoner intent, and stealing it would be a regression in every buffer. Esc from *inside* the peek is the widget's own handler, which a keymap out there cannot reach anyway.

**A block widget lives inside `contentDOM`**, so the outer editor's handlers, vim's included, are on *ancestors*, and a descendant's handler runs before an ancestor's bubble-phase one. `stopPropagation` in the widget's Esc handler is what keeps the key from reaching them. The capture flag beside it is belt and braces: bubble on the widget beats `contentDOM`'s bubble just as well, and capture on the widget does *not* beat a capture handler on `contentDOM`. The first comment here claimed capture was the mechanism and was wrong; mutation proved it.

## Related

- [[concept_lsp_workspace_bridge]] — the rule it borrows and the bridge it avoids
- [[component_call_hierarchy]] — the other "where else" surface
- [[lesson_a_guard_keyed_on_what_changed_is_inert]] — this feature's latest-wins guard, as originally specified
- [[gotcha_reading_the_editor_layout_during_a_cm6_update_throws]] — why nothing here reads layout at all
- [[gotcha_lsp_client_assumes_one_editor_view_per_file]] — the assumption the nested view sits inside
