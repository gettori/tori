---
summary: codemirror's view.viewport is the rendered range plus a margin, for a short file it is the whole document
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 8 (personal/tori, branch `wave-6`); `src/panels/Editor/stickyScroll.ts:158`; commit 2185971"
---

# `view.viewport` is the rendered range, not the visible one

Do NOT read `view.viewport` when you mean "what the user can see". CodeMirror renders a margin beyond the visible area, so for any file shorter than that margin the viewport is the whole document, and anything derived from its start silently answers "the top of the file". Measure the top visible line off the DOM with `posAtCoords` instead. Why: it looks correct in every small test fixture, which is exactly where an implementation gets its confidence.
