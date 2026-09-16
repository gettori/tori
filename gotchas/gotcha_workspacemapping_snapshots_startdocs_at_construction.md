---
summary: WorkspaceMapping snapshots startDocs at construction, so mapPosition throws for any file not yet materialized
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/sway, branch `wave-4`); Phases 3-4; `src/panels/Editor/swayWorkspace.ts`, `lspRename.ts`; commits c5dac84, 7d4ff3a"
---

# `WorkspaceMapping` snapshots `startDocs` at construction

Do NOT create an `@codemirror/lsp-client` `WorkspaceMapping` and then materialise the files it will be asked about. It snapshots `startDocs` from `client.workspace.files` in its constructor (`dist/index.js:437-440`) and `mapPosition` **throws** `"Cannot map from a file that's not in the workspace"` for anything absent (`:466-468`) — inside a promise, so it reads to the user as nothing happening at all. Every file must be materialised *before* the mapping exists. `SwayWorkspace.joinActiveMappings` seeds a live mapping after the fact, but only because the library's own `findReferences` builds its mapping before asking the workspace for a single file and offers no hook; it is a guarded fallback that fails soft, not a licence to drop the ordering. See [[concept_lsp_workspace_bridge]].
