---
summary: narrowing who owns a cwd for display silently zeroed a delete confirm's count, pin destructive counts to physical fact
status: current
updated: 2026-08-25
source: "Features phase 2: Feature selection, the wsKey split and restore (personal/sway, branch `feature-workspace`, issue #154, phase 3 self-review), `src/panels/LeftSidebar/LeftSidebar.tsx:557`, `src-tauri/src/sessions.rs:550`, commit ccae71d"
---

# Lesson: a display attribution rule leaks into a destructive count

## What happened

Phase 3 tightened "who owns this cwd" so a repo never claims sessions or live tabs under its own `.sway/worktrees/` (its Feature worktrees), in `sessions::owned_by_listing` and the sidebar's `tabUnderFolder`. The plan kept `ids_under` inclusive so teardown still finds them. Nobody noticed that `countRunningAgents(repo)`, the number a delete confirm is worded from, is built from exactly the two things that were narrowed: `list_sessions` and the live tabs. Removing a repo with a Feature agent running inside it would have confirmed with "0 running" and then killed it.

## Why

Attribution answers two different questions with one predicate. The tree asks "where should this show", and there the Feature worktree belongs to the Feature. A destructive confirm asks "what will removing this folder reach", and there the physical prefix is the truth. The count reused the listing call because it always had, so the narrowing rode into it unseen. See [[concept_feature_workspace]] and [[component_feature_selection]].

## What to do next time

When a listing or attribution rule gets an exclusion, grep every caller that words a confirm or feeds a teardown, and pin each one to the physical rule on purpose: `list_sessions { inclusive: true }` and a plain cwd prefix on live tabs here. Write the Rust test for both answers on the same cwd, so the two rules cannot drift back into one.

## Related

- [[component_feature_selection]] - where both rules live
- [[gotcha_list_sessions_hides_a_repos_own_sway_worktrees_unless_asked_inclusively]] - the one-line trap
- [[gotcha_counting_live_agents_by_tree_nodes_misses_subdir_agents]] - the earlier undercount on the same count
