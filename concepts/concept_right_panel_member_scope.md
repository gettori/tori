---
summary: sorts 14 right panel modes into whole Feature, file in front, or last clicked repo, merging two launches debug wrong
status: current
updated: 2026-08-28
source: "Features phase 8: the right panel modes inside a Feature (#160), branch `feature-workspace`, phases 1 to 3, commits 6aa93fb and e01f0cf plus phase 3 on the same branch, `src/panels/Editor/Editor.tsx`, `src/utils/featureMembers.ts`"
---

# Which member a right-panel mode answers for

A branch unit is one repo, so every right-panel mode answered for it and nobody had to ask which. A Feature is several ([[concept_feature_workspace]]), and the 14 modes do not agree: some are about the whole Feature, some about the file in front of you, some about the repo you last pointed at. #160 sorted all 14 into exactly three scopes and gave each scope one mechanism.

## The three scopes

**The whole Feature, one section per member.** Files, Changes, Search, Problems, TODOs, Bookmarks. Each takes `roots[]` and draws a band per member ([[component_member_section]] for the three that landed in #160, [[concept_member_fan_out]] for the pattern). A type error in the repo you are not looking at is still one of this Feature's problems, so the availability predicate spans the member set too: `problemsHere()` tests every root, not `activeRoot`, or the tab would hide the section it exists to show.

**The file in front, one repo.** Outline, Calls, Session, Debug. `focusMemberRoot(activeId(), members(), activeRoot)` answers, and it owns all four fallbacks: nothing open, a synthetic view (which belongs to the workspace, not to a repo in it), a path under no member, and a selection that is not a Feature. Each of the four panes carries a line naming the member, because without it they read as answers about the whole workspace. A debuggee runs in one repo, so Debug launches at this root and remembers its target under it.

**The pointer, one repo, switchable.** Pull requests, Tasks, Shared, Docs. These follow `activeRoot`, and [[component_member_chip_row]] under the tab strip is the control that moves it, calling the same `onActiveRoot` the Toolbar's crumb chips and the sidebar use.

## Why the split is three ways and not two

The tempting simplification is "the Feature, or the active member". It breaks on Debug. A run belongs to the workspace, but you start it from the file you are reading, and the file you are reading is routinely in a member other than the one you last clicked in the tree. Collapsing "the file's repo" into "the active member" launched the debuggee in the wrong repo whenever those two disagreed, which is most of the time in a cross-repo Feature.

It breaks in the other direction too. The sweep that stops a debug run used to sit in the `on(root, ...)` effect, so moving `activeRoot` killed the run. The run is the *workspace's*, so the sweep keys on `wsKey`; the launch is the *file's*, so it keys on `focusRoot()`. One value could not have been both.

## What each scope keys its storage on

Not the same thing as what it displays. Breakpoints and bookmarks key on `wsKey` (`feature:<id>`), so they span the Feature. The three debug stores key on the **member root**, because `pausedWorkspace()` compares a session's own `projectPath` against them and a Feature that shared one watch list would dissolve that gate. That split is why deleting a Feature has to sweep both, and why the member-root half of the sweep must stay narrow: [[lesson_a_folder_scoped_purge_can_sweep_another_owners_state]].

## Related

- [[concept_feature_workspace]] - the workspace, and the consumer table naming what every reader gets.
- [[concept_member_fan_out]] - the whole-Feature scope's mechanism.
- [[component_member_section]] - the band the fanned-out list panels draw.
- [[component_member_chip_row]] - the control for the third scope.
- [[concept_repository_identity]] - how a surface says *which* repo, once it knows.
- [[component_debug_launch]] - the launch that moved onto `focusRoot()`.
