---
summary: typescript language server advertises code lenses unconditionally but answers empty until workspace config enables them
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth, Phase 9 (personal/sway, branch `wave-7`); `src-tauri/lsp/typescript.toml`; commit d7a6e3e"
---

# `typescript-language-server` answers no code lenses until a workspace configuration enables them

Do NOT read `codeLensProvider` in the `initialize` reply as "this server will produce lenses". 4.4.1 advertises `codeLensProvider: { resolveProvider: true }` unconditionally, then both providers check the *workspace* configuration before producing anything (`cli.mjs:21364`), so an unconfigured server answers `[]` forever. Measured on a file with three exported symbols: no `[settings]` table, 0 lenses; with one, 3. It is read via `getWorkspacePreferencesForFile` (`cli.mjs:21129`), **not** `initializationOptions`. Why: the capability and the behaviour are decided in different places, and only one of them is on the wire.
