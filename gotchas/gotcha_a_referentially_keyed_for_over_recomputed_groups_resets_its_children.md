---
summary: a For over a freshly rebuilt group array remounts every row by identity even when unchanged, use Index to keep focus
status: current
updated: 2026-09-06
source: "Features phase 8: the right panel modes inside a Feature (personal/sway, branch `feature-workspace`, #160 phase 1, commit 6aa93fb); `src/panels/Editor/ProblemsPanel.tsx`, `src/panels/Editor/BookmarksPanel.tsx`; see [[component_member_section]]; _2026-08-28_; also plan \"Standalone terminals: Sway's own commands as tabs in a Shells workspace\" (personal/sway, branch `standalone-terminals`, issue #166); `src/panels/LeftSidebar/LeftSidebar.tsx` (the Shells list); commit `0bbbdcc`"
---

# A referentially-keyed For over recomputed groups resets its children

Do NOT render a `<For>` over an array your component rebuilds on every data change when the rows own state. Why: `<For>` is keyed by object identity, so a freshly built group array disposes and remounts every row even when the content is identical, and any state the row held goes with it. The Problems and Bookmarks panels group diagnostics and marks into one section per Feature member; the group objects are recomputed whenever a diagnostic lands or a mark is added, so a member the reader had just collapsed reopened itself on the next publish. `<Index>` fixes it: it keys by position, keeps the component instance, and updates the fields that changed. This is the recomputation twin of the reordering entry above, and the fix is the opposite one - there you preserve the references, here there are no references to preserve. Focus is the same kind of loss and easier to miss: the Shells list re-emits as freshly mapped objects whenever the tab on screen changes, so clicking a row rebuilt the row it had just focused and dropped focus to `<body>`, stranding a keyboard user mid-list.
