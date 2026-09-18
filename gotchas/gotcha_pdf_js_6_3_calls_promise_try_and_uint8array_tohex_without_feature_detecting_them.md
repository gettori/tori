---
summary: pdfjs-dist 6.3 calls Promise.try and Uint8Array.toHex with no feature detection, so it throws on older WebKit or Node
status: current
updated: 2026-09-07
source: plan "PDF viewer tab" (personal/tori, branch `logo-update-260907`), phase 1 . `src/panels/Editor/pdfDocument.ts:88` . commit `28df519` . _2026-09-07_
---

# pdf.js 6.3 calls `Promise.try` and `Uint8Array.toHex` without feature-detecting them

Do NOT plan a capability probe for `pdfjs-dist` 6.3, and do not expect it to import under Node 22. Why: it uses both without a guard and both land in Safari 18.2 (December 2024), so on an older WebKit or in a node spike the module throws during *evaluation*. That is convenient rather than awkward: the import failure is the whole probe, so one `catch` around the dynamic import is what turns "needs a newer macOS" into a sentence in the tab. Tori sets no `minimumSystemVersion`, so that sentence is what an older machine gets.
