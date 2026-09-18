---
summary: lsp-client's doRename synchronously skips any file not already opened, a workspace override cannot fix it
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phase 4; `src/panels/Editor/lspRenameCommand.ts`; commit 7d4ff3a"
---

# lsp-client's `doRename` is sync where it needs to be async

Do NOT expect a `Workspace` override to make the library's built-in rename cross file boundaries. At `dist/index.js:1213` `doRename` does `let file = workspace.getFile(uri); if (!lspChanges.length || !file) continue;` — synchronously — so there is no point at which an unopened file can be materialised in time. It silently skips every file the user has not already opened, which is the worst way for a rename to be wrong. Tori ships its own command and binds it at `Prec.highest`; that precedence is required, not tidiness, because the library's keymap arrives through the LSP compartment, which is reconfigured *after* `commonExtensions` is built.
