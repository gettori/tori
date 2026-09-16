---
summary: gitActions.ts keys git state per member root in a Map, so enterRoots gates membership and a slotless read fails closed
status: current
updated: 2026-08-27
source: "Features phase 5: unified changes and the git slot map (#157), branch `feature-workspace`, phases 1 to 4, commits 9658cff, 41b8ab3, 9687380, 3a7e890, `src/utils/gitActions.ts:67,74,99,133,152,191,209`, `src/utils/features.ts:133`, `src/panels/Editor/Editor.tsx:1174`"
---

# One git slot per member, not one per window

A Feature is several repos opened as one workspace ([[concept_feature_workspace]]), so "what does git say" has as many answers as there are members. `gitActions.ts` used to hold one `GitState` behind one signal, blanked on every root switch, which made every answer the active member's answer. It now holds a `Map<root, GitState>` behind one signal, and the whole design follows from splitting two things the old shape had fused: **which roots the store is about** and **what each one currently says**. This is the store-shaped sibling of [[concept_member_fan_out]]: that page is about invoking per member and merging, this one is about holding per member and being read with nothing mounted.

## How it works

- **`enterRoots(roots, active)` is the only writer of membership** (`gitActions.ts:191`). It drops slots outside the set, leaves survivors untouched, seeds newcomers blank, and takes the active root as a separate argument. Every refresh only ever fills a slot; none of them opens or closes one. The old `enterRoot` was called from inside `refreshStatus`, so a refresh doubled as a declaration of what the store was about, and committing in one member would have dropped the others.
- **Membership is keyed on the Selection's `roots`**, through the same `watchKey` memo the fs watcher uses (`Editor.tsx:1174`), not on the `createFeatureMembers` resource. Same set, but synchronous at mount, so there is no resource-timing window where a member has no slot, and git and the watcher can never disagree about what a Feature spans.
- **The stale guard is a per-root generation counter** (`epochs`, `:152`). A read captures its root's generation, and files its answer only if the generation still matches. Leaving the set deletes the entry, so a read for a departed root writes nothing. The generation is also embedded in the coalesce key (`status:<root>#<gen>`, `:215`), which is load-bearing: see [[lesson_a_coalesce_key_must_carry_the_guards_generation]].
- **Membership is strict, and a slotless read fails closed.** `gitStateFor(root)` (`:74`) answers an unentered root with one shared `NO_SLOT` whose `root` is `null`, so a consumer can tell "not conflicted" from "nothing to say" ([[concept_three_way_conflict_model]] needs all three), and a memo comparing `files` by identity sees no change. `refreshStatus` on a root nobody entered resolves without invoking anything. See [[gotcha_a_git_refresh_fills_a_slot_but_never_opens_one]].
- **The no-argument accessors kept their meaning, and the union got its own names.** `stagedFiles()` / `changedFiles()` / `conflictedFiles()` still mean the member in front; `stagedAcross()` / `changedAcross()` / `conflictedAcross()` (`:99`) return every member's rows tagged with the member (`RootedFile`). `canPush(root?)` and `pushingIn(root)` follow the same rule.
- **One `rootOf(path, roots)` rule** (`features.ts:133`) answers "which member owns this absolute path", longest match wins, `null` outside them all. `isConflicted`, the panel's commit target and the palette's `activeRepoPath` all resolve through it, so the three cannot disagree.
- **Events name their repo, and the store listens.** `startGitWatch` (`:356`) refreshes the slot `fs://changed` names in `payload.root` and the one `git://fetch-done|error` names in `payload.repo`. A payload with no root refreshes every slot. This moved out of the Changes panel, so status stays true with the panel closed.
- **Counting is per member and asked per member.** The sidebar's change count sums `gitStateFor(m.worktreePath).files.length` over the Feature's own members rather than totalling the map, so a number is attributed by what measured it ([[lesson_attribute_a_number_by_what_measured_it]]).

## Why it's this way

**Strict membership fails closed rather than fails wrong.** The lenient alternative, where a refresh seeds its own slot, needs no `enterRoots` in a fixture and never paints blank. Its failure mode is a slot nobody is in still answering the palette, which is how you offer "Commit" on a workspace that closed. Strict membership's failure mode is "silently nothing", which is visible and safe. The cost is explicit setup in seven test files that used `await refreshStatus(null)` as a reset; that cost is the contract made visible.

**A union under the old accessor names would have compiled clean and been wrong.** `stagedFiles()` is read with no argument by the palette's gating (`Omnibox.tsx`) and by the editor's commit guard, which then commits in one root. Returning a union there enables Commit on member B's staged file and runs it in member A, with no type error anywhere. Naming the union separately is the whole guard.

**The six single-slot consumers were fixed, not left.** Blame, the commit log and the conflict banner all gate on `gitState().root === <their root>` and fail closed, so since #154 put every member's files in one workspace they were already dead for every member but the active one. The slot map made each a one-line change to `gitStateFor(<their own root>)`.

**Per-member flags, not one.** `pushing` was one boolean; with a Push button per member section it would have labelled every one of them "Pushing..." for a push in any one and silently refused the rest.

**The cost is real and accepted.** Every burst now runs `git status` once per member root even with nothing looking at it. That is what makes the palette's gates and the sidebar's count correct with the panel closed, and window focus stays the only recovery from terminal-side git because `.git` is watcher-filtered ([[gotcha_the_project_watcher_must_filter_churn_dirs]]).

## Related

- [[concept_feature_workspace]] - the workspace this holds one slot per member of.
- [[concept_member_fan_out]] - the invoke-and-merge sibling; this is the hold-and-read one.
- [[component_editor_stores]] - the module this lives in, and its editor-state neighbour.
- [[component_changes_panel]] - the surface that reads one slot per section.
- [[component_feature_list]] - the sidebar row that sums them.
- [[lesson_a_coalesce_key_must_carry_the_guards_generation]] - the bug making the guard finer introduced.
- [[gotcha_a_git_refresh_fills_a_slot_but_never_opens_one]] - the fixture trap strict membership creates.
- [[concept_porcelain_v2_status]] - what a slot's `files` are.
- [[adr_feature_workspace]] - the decision that single-root commands stay single-root.
