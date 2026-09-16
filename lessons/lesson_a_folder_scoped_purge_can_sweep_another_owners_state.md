---
summary: a purge keyed on a folder path can sweep another owner's state on that path, so widen it to a named subset of stores
status: current
updated: 2026-08-28
source: "Features phase 8: the right panel modes inside a Feature (#160), branch `feature-workspace`, phase 2, commit e01f0cf, `src/utils/purgeWorkspace.ts`, `src/panels/Editor/Editor.tsx` (`dropMemberDebugState`)"
---

# A folder-scoped purge can sweep another owner's state

## What happened

Deleting a Feature sweeps `feature:<id>` out of the 14 per-workspace stores. Three of them do not hold the Feature under that key at all: `sway.watches`, `sway.debugAttachPorts` and `sway.debugLastTarget` key on the **member root**, because a paused session's own `projectPath` is compared against it and one shared watch list would dissolve the per-member gate. So those three records survived every Feature delete.

The obvious fix is to pass the member roots in and sweep them too. Written that way it swept the *whole* store list under each root, and emitted `PURGE_WORKSPACE` once per root so every live owner ran its full teardown for that key.

That is wrong, and the reason is one screen away in the same feature. Deleting a Feature **offers** each worktree rather than removing it (#159): the sweep dialog has a Keep button, and a kept worktree stays reachable as a branch unit, which is why a plain repo lists its contained worktrees at all. A member you keep can be opened straight afterwards, and its tabs, terminals and tree state are keyed by that same folder. The broad sweep would have deleted them, on the way out of a Feature that never owned them.

## Why it is easy to get wrong

The key looked like it identified the thing being deleted. It does not: it identifies a *folder*, and a folder can have more than one owner. `feature:<id>` is unambiguous by construction because it is not a path. A member root is a path, and the Feature is only one of the things keyed by it.

The generic sweep helper made this invisible. `purgeStoredWorkspace(ws)` takes a key and drops it from everything, which is exactly right for a key nothing else can mean, and silently over-reaches for one that other things can.

## What to do next time

- **Ask what else keys on this string before widening a sweep to it.** Not "what does this delete own", but "what else names this folder".
- **Name the subset.** `MEMBER_ROOT_STORES` is three entries beside the fourteen, and the list is the documentation: everything else a member folder can appear in belongs to that folder as a branch unit.
- **The event needs the same narrowing as the storage.** `PurgeWorkspace` gained `roots?: string[]` so the live half could run `dropMemberDebugState` for them instead of the full `purgeWorkspaceKey`. Firing the whole teardown once per root would have been just as destructive as the broad stored sweep, and would not have shown up in a localStorage assertion.
- **A "keep" affordance elsewhere in the same feature is a constraint on your cleanup.** It was written one ticket earlier, in a different file, and nothing linked the two.

## Related

- [[concept_feature_workspace]] - the purge, and the two key shapes a Feature is stored under.
- [[concept_right_panel_member_scope]] - why the debug stores key on a member root in the first place.
- [[component_feature_list]] - the delete flow that offers each worktree.
- [[concept_path_keyed_workspace_stores]] - the store layer this sweeps.
