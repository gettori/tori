---
summary: createFeatureMembers caches one read per generation module wide, swapping payloads mid file reuses the first answer
status: current
updated: 2026-08-28
source: "Repository identity on tabs, breadcrumbs, quick-open and menus (personal/tori, branch `feature-workspace`, issue #158) - phases 3 and 4 - `src/utils/featureMembers.ts:144,162`, commits 12fe232, 809c85b - _2026-08-28_"
---

# Feature members are read once per generation, module-wide

Do NOT write a test that swaps the `list_features` payload between cases inside one file. Why: `createFeatureMembers` shares by construction, `readAt(tick)` caches one promise pair **per generation for the whole module** and `watchFeatureSources()` guards on a `listening` flag, so the second case is served the first case's answer and the failure reads as a component that ignored its props. That sharing is deliberate (the crumb bar, the sidebar and the tree all want the same two answers on one switch) and the listeners are never removed by design. Put every Feature the file needs in **one** payload under different ids and select between them with `featureId`, which is what `featureQuickOpen.test.tsx` (`f1`, `f1b`, `f8`) and `Toolbar.test.tsx` (`f1`, `f2`) do.
