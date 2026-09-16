---
summary: list_sessions attributes a Feature worktree to its member not the repo, pass inclusive true for a destructive count
status: current
updated: 2026-08-25
source: Features phase 2 (#154), branch `feature-workspace`, `src-tauri/src/sessions.rs:550`, `src/panels/LeftSidebar/LeftSidebar.tsx:557`, commit ccae71d, _2026-08-25_
---

# `list_sessions` hides a repo's own `.sway/worktrees` unless asked inclusively

Do NOT count what removing a folder will kill with a bare `list_sessions { folder }` or with `tabUnderFolder`: both attribute a Feature worktree to its member, not to the repo that holds it. Pass `inclusive: true` and a plain cwd prefix on live tabs for any destructive count; `ids_under` already does. Why: the tree's ownership rule and the teardown rule are two different questions, see [[lesson_a_display_attribution_rule_leaks_into_a_destructive_count]].
