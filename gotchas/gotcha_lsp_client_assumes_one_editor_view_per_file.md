---
summary: lsp-client's Workspace expects one EditorView per file, so cross-file jumps fail in Sway's single shared editor view
status: current
updated: 2026-06-29
source: CM6 migration (personal/sway); `src/lspClient.ts`, `node_modules/@codemirror/lsp-client` d.ts; commit 15d039e
---

# lsp-client assumes one editor view per file

Do NOT expect `@codemirror/lsp-client`'s default workspace to drive cross-file go-to-def in Sway; it returns an `EditorView` per file and allows one editor per file, while Sway uses one `EditorView` with swapped `EditorState`s. Why: `Workspace.displayFile` (used by `jumpToDefinition` for other files) can't map onto the single view, so cross-file jump needs a custom `Workspace` that emits `OPEN_IN_EDITOR`. Same-file jump, completion, hover, and diagnostics work with the default.
