---
summary: keeping a PDF page's height fraction fixed across a zoom is not keeping the page steady, since it reads a fixed line
status: current
updated: 2026-09-07
source: plan "PDF viewer tab" (personal/tori, branch `logo-update-260907`), phase 2 . `src/panels/Editor/PdfView.tsx:229`, `src/panels/Editor/pdfLayout.ts:205` . commit `2f19355`
---

# Re-anchor a zoom on the line the position is read from

## What happened

The plan said to keep "the page at the top of the viewport at the same fraction" across a zoom. That was built, and the reported page slipped on every zoom step: zoom in three times and reset, and the reader was on a different page than they started on. The test for that verify caught it; reading the code did not.

## Why

Two different things were being kept still.

The **reading position** is `(page, offset)` where `offset` is a fraction of that page's height. The **page number** is read from a probe line a fixed third of the way down the viewport, because a page's last line is still what you are reading once the next page has come into view, and a toolbar that renumbers the instant a sliver appears is wrong more often than right.

A fraction scales with the page and a fixed distance does not. A page whose top sits 29% of a page above the fold is 232px up at 100% and 618px up at 200%. Restore the fraction and the probe, still 300px down, now lands on the previous page. The anchor was correct for the thing it preserved and simply preserved the wrong thing.

The fix is to anchor on the probe line itself, which makes the page stable by construction rather than by arithmetic that happens to agree. The awkward part is timing: by the time an `on(scale, ...)` effect runs, the heights memo has already moved, so the place cannot be worked out afterwards. It has to be **recorded at scroll time under the heights that were on screen**, and read back later. A pinch takes the same path with the pointer's Y instead of the probe's.

## What to do next time

- **Anchor a re-layout on the same line the state you display is derived from.** If the toolbar reads the page from a probe a third of the way down, that is the line to keep still. Preserving a different point is preserving a different fact.
- **Record the anchor before the layout moves.** A derived memo has already recomputed by the time the effect that reacts to it runs, so an anchor computed there is computed under the new geometry. Capture it where the user's position was last true.
- **A fraction and a fixed pixel distance are not interchangeable across a scale change**, even when they agree at one scale. Any time both appear in one position model, check what happens at 2x.
- **Write the test for the plan's own wording, then read what it says.** The plan's phrasing pointed the wrong way and the test is what proved it; a stability claim like "zoom in three times and reset lands on the same page" is cheap to assert and would not have been noticed by review.

## Related

- [[component_pdf_viewer]] - `placeAt` / `scrollTopFor` and the effect that uses them.
- [[gotcha_jsdom_never_fires_selectionchange_and_its_range_has_no_getboundingclientrect]] - the neighbouring cost of testing anything geometric in this pane.
