---
summary: keymap.of as a top-level LSPClient extension is a bare FacetProvider, so lsp-client silently drops it
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth, Phase 4 (personal/sway, branch `wave-7`); `src/panels/Editor/lspClient.ts:382`; commit bd8158a"
---

# A bare keymap FacetProvider is dropped by lsp-client

Do NOT pass `keymap.of([...])` as a top-level entry in an `LSPClient`'s `extensions`. The client keeps a configured extension only if it is an array or carries `.extension` (`lsp-client/dist/index.js:551`), and `keymap.of(...)` returns a bare `FacetProvider`, which is neither — so it is silently discarded. `languageServerExtensions()` spreads its keymap exactly that way, which is why F12, ⇧F12, F2 and ⇧⌥F were never actually bound by the library while `commands.ts` advertised three of them as `sub:` labels. Wrap it in an array. Why: the drop is silent, and the keys still work if anything else happens to bind them.
