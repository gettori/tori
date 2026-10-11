---
summary: list_worktrees_body drops worktrees in dot folders, so a repair list built from it misses .wiki style checkouts
status: current
updated: 2026-10-11
source: "gettori/tickets#74, convert a plain clone to the bare plus worktree layout (personal/tori, branch phase-1-block-2); src-tauri/src/worktree.rs worked_in; src-tauri/src/convert.rs linked_worktrees"
---

# `list_worktrees_body` hides dot-folder worktrees

`worked_in` filters out any linked worktree whose folder name starts with a dot, so the `.wiki` checkout never becomes a sidebar row. That is right for the sidebar and wrong for anything that must touch every worktree: a repair list built from it leaves a dot-folder worktree pointing at a git dir that moved. [[concept_worktree_layout_conversion]] reads `git worktree list --porcelain` raw instead.
