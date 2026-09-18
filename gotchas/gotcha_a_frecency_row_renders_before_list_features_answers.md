---
summary: the omnibox draws a jump list row from localStorage first, its member label lands a tick later, assert in waitFor
status: current
updated: 2026-08-28
source: "Repository identity on tabs, breadcrumbs, quick-open and menus (personal/tori, branch `feature-workspace`, issue #158) - phase 4 - `src/components/Omnibox/Omnibox.tsx:206`, `src/components/Omnibox/featureQuickOpen.test.tsx:184`, `src/components/Omnibox/Omnibox.test.tsx`, commit 809c85b - _2026-08-28_"
---

# A frecency row renders before `list_features` answers

Do NOT assert a member-derived label synchronously on a row the Omnibox draws from local storage. Why: the jump list and the Recent files block render on the first frame from `localStorage`, while `createFeatureMembers` is still resolving, so the row exists immediately and its `api/` prefix arrives a tick later; the row's id never changes, so nothing moves, only the text grows. Wrap the label assertion in `waitFor`. The same timing bit a second way: waiting on a row the frecency block renders synchronously does **not** wait for `list_project_files`, so a test that means to await the listing must await something only the listing produces.
