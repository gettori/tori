---
summary: evicting a row a selection's Range anchors in collapses it, removing a node between the two ends silently empties it
status: current
updated: 2026-09-07
source: plan "PDF viewer tab" (personal/tori, branch `logo-update-260907`), phase 3 . `src/panels/Editor/PdfView.tsx:115` . commit `dc57d79` . _2026-09-07_
---

# Removing a node a Range is anchored in collapses the selection

Do NOT evict a virtualised row, page or block while a selection reaches it. Why: a `Range` whose boundary node is removed from the document collapses, so the user's selection silently vanishes on scroll; and the quieter twin is worse, because removing a node *between* the two ends leaves the range perfectly valid and just empties it, so `toString()` returns the right start and end with the middle missing. Widen the eviction window by the selection's own span (as two ranges, not one bounding box, or a selection on page 3 read from page 300 mounts everything between), and if the widening is async, await it before reading the selection.
