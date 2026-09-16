---
summary: the sidebar tree's rail and inset are driven by three custom properties, nest a level by re-anchoring them, not the css
status: current
updated: 2026-07-29
source: Chat surface plan, phase 12 (personal/sway, branch `chat`); `src/panels/LeftSidebar/LeftSidebar.module.css` (`.attemptNode`, `.row.sub1`, `.row.sub2`)
---

# The sidebar rail is a variable, not a copy

Do NOT copy the branch-graph CSS to nest a new level in the sidebar tree (a fan-out group's attempts sit one level below a branch). The rail, elbow, hover pill and session inset are all driven by three custom properties, so a nested node re-anchors them and every existing rule draws the deeper level unchanged: `.attemptNode` shifts `--rail-x`, `--rail-x-row` and `--branch-label-x` by one `--nest-step`. `.row.sub2` is expressed as `--branch-label-x + --nest-step` (the same 46px at the top level it always was) precisely so one override moves a whole subtree. Declare the nested class **after** `.branchNode`; they tie on specificity, so source order decides.
