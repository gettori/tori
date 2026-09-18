---
summary: codemirror's autoSync debounces document changes by 500ms, a positional request in that window gets wrong line numbers
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phases 5, 7; `src/panels/Editor/lspSymbols.ts`, `lspSemanticTokens.ts`; commits cbc5b0a, 075b5d7"
---

# `autoSync` is debounced, so `sync()` before a position request

Do NOT ask a language server anything positional without flushing first. `@codemirror/lsp-client`'s `autoSync` debounces document changes by **500 ms** (`dist/index.js:1794`), so a request made inside that window is answered against the document as it was before the last keystroke. For diagnostics that is harmless; for `documentSymbol` or `semanticTokens/full` — replies that are *entirely* positions — every line number comes back wrong by however much was typed, and the outline looks right while every row jumps to the wrong line. `LspTarget.sync()` exists for this and every positional request calls it.
