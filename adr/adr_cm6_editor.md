---
summary: editor drops the cross origin code server iframe for same origin CodeMirror 6, so drag to terminal finally works
status: current
updated: 2026-08-03
source: CM6 editor migration plan (personal/tori, branch code-mirror-6); commits ccd7337->15d039e (Phases 1 to 11); amended 2026-08-03 by the editor roadmap discussion and Editor wave 4 (branch `wave-4`, commits 7bb34d2->14b389b)
---

# Editor: CodeMirror 6 (same-origin) with bundled LSP, over code-server

Tori's editor moves from the **code-server VS Code iframe** back to a **same-origin CodeMirror 6** editor wired by us. The code-server `<iframe>` is cross-origin, which makes the cross-pane features Tori actually wants impossible: dragging a file from the explorer onto the terminal, clicking a `file:line:col` path in the terminal to open it, sharing the theme, and any deep editor↔terminal glue. CM6 runs in the same SolidJS document as the xterm terminal, so all of that becomes ordinary function/signal calls. This supersedes the editor half of [[adr_stack_choice]] (which went Monaco -> code-server).

We accept rebuilding the IDE surroundings ourselves (file tree, tabs, save, git gutter, diff) because that is the price of same-origin integration, and because Tori is an agent/terminal-first tool that *shows* code, not an IDE that runs agents. To keep it genuinely useful we still ship language intelligence: **Tori bundles a TS/JS language server** (`typescript-language-server` + `typescript`) and bridges JSON-RPC to `@codemirror/lsp-client`, so completion/hover/diagnostics/go-to-def work with no project-local install.

The PTY output stream is also rewritten from base64-over-global-events to **Tauri Channels**, pairing with an xterm **WebGL** renderer for smooth high-throughput output.

## Considered Options

- **Editor:** stay on code-server (rejected: cross-origin iframe blocks drag-to-terminal, click-to-open, theme sharing) vs Monaco again (rejected: heavier in-webview, no real edge over CM6 here) vs fork Code-OSS / Theia (rejected: drops the Tauri shell entirely, Electron weight, upstream rebase tax) vs **CodeMirror 6** (chosen: lightest same-origin citizen, first-class gutter API, themes from our CSS vars).
- **LSP:** none / defer (rejected: user wants real intelligence) vs rely on project-local servers (rejected: setup friction) vs **bundle the TS/JS server** (chosen).

## Consequences

- We own the file tree, tabs, save/dirty/conflict handling, git gutter, and inline diff, none come for free as they did with VS Code (built in [[component_cm6_editor]]).
- No VS Code extensions, debugger, or non-TS/JS language servers until separately built.
- **Decided (Phase 11): system `node` only**, resolved via `env::augmented_path`; no bundled Node runtime (smallest bundle — if `node` is absent the server simply doesn't start). See [[component_lsp_host]].
- `codeserver.rs`, the iframe, and the `base64` crate are removed; the editor and terminal now share one document and the `fs://changed` / `OPEN_IN_EDITOR` contracts ([[concept_fs_change_pipeline]]).
- ~~**Known follow-up:** cross-file **go-to-def** is not wired~~ — **resolved 2026-08-03** by [[concept_lsp_workspace_bridge]], the adapter that satisfies a one-view-per-file library from a single-view editor. Go-to-definition, find-references and rename all cross file boundaries now.

## Amendment, 2026-08-03: the ceiling, and what is permanently out

The roadmap discussion of 2026-08-01 settled the editor's ceiling as **proper IDE, agent-first** — raised from "daily driver" the same day. That is what un-capped language intelligence and is the premise the whole wave-4 programme rests on: the single hard-coded TS/JS server generalises to a registry, cross-file navigation gets fixed, and daily-driver comforts (outline, format-on-save, vim mode) become real backlog rather than nice-to-haves. Recorded here because it appears in no diff.

**Deliberately and permanently out of scope**, because each contradicts the same-origin/lightweight choice this ADR makes:

- **Extension marketplace** — a plugin host is the weight that made the VS Code iframe untenable.
- **Remote development** — the editor's value here is that it shares one document with the terminal on this machine.
- **CRDT collaboration** — a different product with a different data model.
- **A tree-sitter swap** — Lezer is CM6's own parser and already ships the grammars Tori needs; the accuracy gap that motivated a swap is closed by [[concept_semantic_token_layering]] instead.

These are not "not yet". They are decisions, and re-litigating one means reopening this ADR.

Sequenced elsewhere, not out: minimap (wave 5), sticky scroll and breadcrumbs (wave 6, consuming [[component_editor_symbols]]), deeper LSP surface — code actions, peek, call hierarchy, schema servers (wave 7), debugger (an open decision in the wave 6 handoff).

## Related

- [[adr_stack_choice]] — the prior stack decision whose editor choice this supersedes.
- [[component_cm6_editor]] — the editor pane this decision produced.
- [[component_lsp_host]] — the language intelligence, now a TOML server registry rather than one bundled server.
- [[concept_lsp_workspace_bridge]] — what closed the cross-file follow-up above.
- [[concept_lsp_capability_contract]] — the rule governing what Tori tells a server it can do.
- [[component_project_formatter]] · [[component_editor_symbols]] · [[concept_semantic_token_layering]] — the wave-4 surfaces built on it.
- [[component_pty_host]] — the terminal half, now streamed over Tauri Channels.
- [[concept_fs_change_pipeline]] — the disk-change glue the same-origin editor relies on.
- [[concept_filesystem_source_of_truth]] — the editor reads/writes disk directly, consistent with this.
