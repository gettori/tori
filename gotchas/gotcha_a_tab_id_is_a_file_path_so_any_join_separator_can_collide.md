---
summary: joining tab ids with a separator a file path can contain lets two different id lists collide on one cache key
status: current
updated: 2026-08-20
source: plan "Worktree and tab switching at native speed" (phase 4, personal/sway, branch `unified-tab-bar`), `src/components/OverflowTabBar.tsx`, commit f16b6ae, [[component_overflow_tab_bar]], _2026-08-20_
---

# A tab id is a file path, so any join separator can collide

Do NOT build a cache key by joining tab ids with a separator that a path can contain. Why: an editor tab's id **is** its file path, so joining with a space makes `["a b","c"]` and `["a","b c"]` the same key, and a real change silently skips its re-measure. Pick a separator no path can hold, and write it as an escape sequence rather than the literal byte, or the source file turns binary and grep and diff stop reading it (that mistake cost a round trip on its own).
