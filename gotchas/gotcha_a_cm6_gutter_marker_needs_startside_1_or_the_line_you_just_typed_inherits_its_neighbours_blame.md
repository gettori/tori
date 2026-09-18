---
summary: a CM6 gutter marker at default startSide sits before an insertion, so a line typed at line start shows the wrong blame
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phases 8, 9; `src/panels/Editor/blameGutter.ts`; commits ad173e9, 6dc425f"
---

# A CM6 gutter marker needs `startSide = 1` or the line you just typed inherits its neighbour's blame

Don't leave a CodeMirror gutter marker's range at the default side. Why: side 0 maps to *before* an insertion, so text typed at exactly a line's start leaves the marker behind and the line you just wrote shows the blame of the line it pushed down. That is the one failure mode where provenance **lies** rather than going missing, which is far worse: a missing marker reads as "uncommitted", a wrong one reads as fact. Set `startSide = 1` on every marker range that must follow the text after it. Both the blame and the agent-attribution marker sets needed it, and the same test caught each.
