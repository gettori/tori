---
summary: counting live agents by rendered sidebar nodes undercounts one running in an unrendered subdirectory
status: current
updated: 2026-07-10
source: Delete Group (personal/tori, branch code-mirror-6); `src/pathScope.ts`, `src/components/Sidebar.tsx` (`countRunningAgents`); commit fef06e6
---

# Counting live agents by tree nodes misses subdir agents

The sidebar's "running dots" set is keyed by **rendered session nodes**, but an agent can run in a **subdirectory** that is not itself a session node. So counting live agents under a space (or any folder) by intersecting the rendered nodes **undercounts** — exactly the case a destructive-op warning most needs to show. Use the same primitive the worktree-removal guard uses: `list_sessions({ folder })` (Rust prefix-matches every session whose recorded `cwd` is the folder or nested under it, see [[component_session_scanner]]) + `session_running` per id, then count. The pure `countRunningUnder` helper encodes the prefix rule (`isUnderPath`) so it is unit-tested independently of Tauri. See also [[gotcha_git_worktree_list_reports_canonical_paths]] (the same prefix-match trap).
