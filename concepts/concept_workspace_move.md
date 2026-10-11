---
summary: moveWorkspaces rewrites per-workspace keys and paths for moved folders, the non-destructive twin of purgeWorkspace
status: current
updated: 2026-10-11
source: "gettori/tickets#74, convert a plain clone to the bare plus worktree layout (personal/tori, branch phase-1-block-2); src/utils/moveWorkspace.ts; commit 42a2de53"
---

# Workspace move

When folders move and nothing about them closed, every per-workspace store follows instead of dropping its entry. Used by [[concept_worktree_layout_conversion]], where the unit folder changes from `<proj>` to `<proj>/<leaf>` and Tori worktrees from `<proj>/.tori/worktrees/<slug>` to `<proj>/<slug>`.

## How it works

- `movedPath(path, moves)` rewrites by the deepest move that holds the path, so a Tori worktree move beats the project move.
- `moveDeep(value, moves)` rewrites every key and string of a plain JSON value.
- `moveWorkspaces(moves)` rewrites every `WORKSPACE_STORES` record in localStorage, then emits `WORKSPACE_MOVED`.
- Live owners listen, mirroring the `PURGE_WORKSPACE` listeners: Editor (tabs, active, closed, jumps, frecency, debug stores, breakpoints, tree state, watches), App (pane layout and placements), Terminal (inert tabs and their cwd; live ones are refused upstream) and SearchPanel.

## Why it is this way

`PURGE_UNDER_PATH` is a delete: it drops breakpoints, tree state, closed-tab history and stashed unsaved work. A move that reused it would lose state the user kept on purpose. Workspace keys are the unit folder, not the file paths, so a path-only rename (`followRename`) would leave every tab under a key nothing selects.

## Related

- [[gotcha_a_prefix_move_into_its_own_subfolder_is_not_idempotent]] the trap in applying it
- [[gotcha_feature_id_is_a_key_not_a_path_so_purge_under_path_never_reaches_it]] the purge side's key versus path split
