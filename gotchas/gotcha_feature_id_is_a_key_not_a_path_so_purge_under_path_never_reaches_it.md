---
summary: a feature id localStorage entry is a key not a path, so PURGE_UNDER_PATH never matches it, use purgeWorkspace instead
status: current
updated: 2026-08-25
source: Features phase 2 (#154), branch `feature-workspace`, `src/utils/purgeWorkspace.ts:9`, commit 282e06f, _2026-08-25_
---

# `feature:<id>` is a key, not a path, so `PURGE_UNDER_PATH` never reaches it

Do NOT sweep a Feature's stores with the path purge: that event matches file paths under a folder and a `feature:<id>` key is under nothing. Emit `PURGE_WORKSPACE { workspace }` from `purgeWorkspace(ws)`, which rewrites the 14 localStorage stores first and only then tells the live owners, because some of them persist on change and would write the key back. Why: every per-workspace store is `Record<workspace, ...>` and the key is the only handle.
