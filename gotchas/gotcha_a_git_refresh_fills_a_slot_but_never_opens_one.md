---
summary: refreshStatus, refreshMeta and refreshGit no op on a root the store does not know, call enterRoots to open the slot
status: current
updated: 2026-08-27
source: Features phase 5 (#157), branch `feature-workspace`, `src/utils/gitActions.ts:191,209`, `src/panels/Editor/ReviewPanel.stories.tsx` (`loadRoots`), commit 9658cff, _2026-08-27_
---

# A git refresh fills a slot but never opens one

Do NOT expect `refreshStatus` / `refreshMeta` / `refreshGit` to make the store know about a root: they resolve without invoking anything when the root is not a member. Why: `enterRoots` is the only writer of membership in `gitActions.ts:191`, deliberately, so committing in one member of a Feature cannot drop the slots beside it. A test or a story that only refreshes therefore paints nothing and reads as a repo with no changes; call `enterRoots([...roots], active)` first, which is what `Editor.tsx` does on every selection change. The old reset idiom `await refreshStatus(null)` is gone for the same reason and is now `enterRoots([])`.
