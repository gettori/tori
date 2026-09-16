---
summary: jsdom never fires selectionchange and its Range has no getBoundingClientRect, so both must be handled by hand
status: current
updated: 2026-09-07
source: plan "Chat composer Tier 1" (personal/sway, branch `composer-260907`), phase 3 . `src/panels/Chat/QuoteSelection.tsx:44` . commit `c3eb12f` . _2026-09-07_; re-hit by the PDF's Quote in "PDF viewer tab" (branch `logo-update-260907`), phase 3 . `src/panels/Editor/pdfView.test.tsx` . commit `dc57d79` . _2026-09-07_
---

# jsdom never fires `selectionchange`, and its `Range` has no `getBoundingClientRect`

Do NOT expect a selection-driven component to do anything under test on its own, and do NOT call range geometry unguarded. Why: jsdom implements `getSelection` and ranges but fires no `selectionchange` event, so the test has to set the range and `document.dispatchEvent(new Event("selectionchange"))` by hand; and `Range.getBoundingClientRect` is simply absent, so a component that positions itself off a selection throws an unhandled error in the middle of an otherwise passing file.
One more thing goes with it: **a CSS Module class is not a query handle**, because vitest stubs those imports so `styles.textLayer` is `undefined` and the element renders with no class at all. Reach for a `data-*` attribute the component already needs (`[data-pdf-page]`), or a role, and never `container.querySelector('.' + styles.x)`.
