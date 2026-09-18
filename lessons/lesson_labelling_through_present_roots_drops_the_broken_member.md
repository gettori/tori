---
summary: labelling a path through only the present members prints a bare path for a broken one, so naming needs the full record
status: current
updated: 2026-08-28
source: "Repository identity on tabs, breadcrumbs, quick-open and menus (personal/tori, branch `feature-workspace`, issue #158) - phase 4 self-review - `src/components/Omnibox/Omnibox.tsx:321`, `src/utils/featureMembers.ts:113`, commit `809c85b`"
---

# Label through the member record, never through the selection's present roots

## What happened

The plan wrote the rule down as a Decision on day one: "`memberFor` matches every member, not just present roots." Phase 4 then broke it anyway. The Omnibox's `pathLabel`, which names a jump target or a frecency row from an absolute path, resolved through `rootOf(abs, roots())`, and `roots()` is `Selection.roots`. So a file whose member had lost its worktree printed as a bare absolute path in quick-open while the same file's tab, three inches above, still read `web / b.txt`. Self-review caught it, not a test: every phase-4 test used a Feature whose members were all present.

## Why

`Selection.roots` is built by `featureRoots`, which filters on `state.kind === "present" && worktreePath`. It is the right input for a **listing** (you cannot grep a folder that is not there) and the wrong input for a **label**. The two questions look identical at the call site, both are "which root does this path belong to", and the wrong answer is not an error: it is a plausible-looking absolute path. The member record, read through `createFeatureMembers`, keeps every member including the broken ones, which is exactly what `memberFor` was written against.

## What to do next time

Before resolving a path to a member, ask which question you are answering.

- **Listing or acting** (grep it, walk it, spawn in it, stage in it): `Selection.roots`. A broken member has nothing to list.
- **Naming** (a label, a chip, a crumb, a heading, a tooltip): `memberFor(path, members())` over the full member list, with `rootOf(path, roots())` at most as a fallback.

And write the test with a broken member in it. A fixture where every member is present cannot distinguish the two, so the rule stays unenforced no matter how prominently the plan states it. The fix's own test (`featureQuickOpen.test.tsx`, "still names the repo of a file whose member lost its worktree") was proven to fail without the fix before it was kept.

## Related

- [[concept_repository_identity]] - the rule this is the enforcement half of
- [[concept_feature_workspace]] - where `Selection.roots` comes from and what else reads it
- [[component_member_chip]] - the chip that would vanish under the same mistake
- [[gotcha_read_selectionroot_never_folderpath_for_git_settings_the_watcher_or_a_spawn]] - the neighbouring "which root does this ask" trap
- [[gotcha_a_members_path_moves_only_repopath_survives_a_recreate]] - the other place a member's identity is not what it looks like
