---
summary: jsdom's accessible name joins adjacent nodes with no separator, an exact match passing in a browser finds nothing
status: current
updated: 2026-08-28
source: "Repository identity on tabs, breadcrumbs, quick-open and menus (personal/tori, branch `feature-workspace`, issue #158) - phase 2 - `src/panels/Editor/featureTabIdentity.test.tsx:104`, `src/styles/patterns.module.css:62`, commit 6183eae - _2026-08-28_"
---

# jsdom's accessible name joins adjacent nodes with no separator

Do NOT assert an exact string on an accessible name assembled from a visually-hidden span plus adjacent text. Why: `dom-accessibility-api` trims each node's text and concatenates without a separator, so `<span class=srOnly>api / </span>a.txt` computes as `"api /a.txt"` under jsdom and `"api / a.txt"` in a browser; an exact-match query silently finds nothing and the test reads as a missing chip. Anchor with a tolerant regex instead, e.g. `new RegExp("^" + repo + "\\s*/\\s*" + file + "$")`, which is what `NAMED()` in `featureTabIdentity.test.tsx` is.
