---
summary: npm install crashes on this pnpm managed tree and can exit 0 while persisting nothing, always use pnpm add
status: current
updated: 2026-08-01
source: "Editor wave-1 opener: multi-cursor, editing polish, language packs (branch `editor-improvements`); `pnpm-lock.yaml`"
---

# npm cannot graft onto this pnpm tree

Don't `npm install <pkg>` in the tori repo: the tree is pnpm-managed (`node_modules/.pnpm`, no package-lock.json), npm's arborist crashes with `Cannot read properties of null (reading 'edgesOut')`, and one run even exited 0 while persisting nothing. Why: npm cannot reconcile pnpm's symlinked layout; use `pnpm add`.
