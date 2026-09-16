---
summary: sel.folderPath mirrors empty for a zero present Feature, so git or watch calls run against nothing, use selectionRoot
status: current
updated: 2026-08-25
source: Features phase 2 (#154), branch `feature-workspace`, `src/utils/features.ts:136`, commit 7ef9670, _2026-08-25_
---

# Read `selectionRoot`, never `folderPath`, for git, settings, the watcher or a spawn

Do NOT read `sel.folderPath` as the folder to run something in: a Feature mirrors `activeRoot` there and a zero-present Feature mirrors `""`, which `git_status` and `fs_watch_start` would happily receive. `selectionRoot(sel)` returns `null` instead; `workspaceKey(sel)` is the store key. Why: the mirror exists only so un-migrated consumers keep working, and `""` is what un-migrated means.
