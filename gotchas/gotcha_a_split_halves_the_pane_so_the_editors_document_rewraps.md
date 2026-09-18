---
summary: a pane split rewraps the editor's document, so compare the first visible line, not a pixel scrollTop reading
status: current
updated: 2026-08-20
source: "plan \"The reveal path: verify the mismatch switch, then decide what it costs\" (phase 3, personal/tori, branch `unified-tab-bar`), `src/utils/perfRecipe.ts`, commit dab0114, [[lesson_a_pixel_is_not_a_position]], _2026-08-20_"
---

# A split halves the pane, so the editor's document rewraps

Do NOT compare an editor's `scrollTop` (or any pixel-derived reading) across a split, a pane move or a mismatch switch. Why: the pane's width halves, CodeMirror rewraps the document, and the same content sits at a different offset. Measured on one 2644-character file, the scroll height went from 3137px to 4649px with the reader not having moved. Compare the first visible line instead, and keep the pixel in the record so a difference can be classified as a rewrap rather than a lost position. This is the editor's version of the rule that already forbids byte-identity checks on a reflowed terminal buffer.
