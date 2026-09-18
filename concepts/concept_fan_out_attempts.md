---
summary: fan out attempts live inside the project root since a session outside it vanishes; promotion deletes losers, not merges
status: current
updated: 2026-07-29
source: Chat surface plan, phase 12 (branch `chat`); `src-tauri/src/attempts.rs`; `src/panels/LeftSidebar/attempts.ts`; commit "Run several attempts at one task, and promote one"
---

# Fan-out attempts

Several independent attempts at one task, each in its own worktree, one of which
is promoted while the rest are discarded outright. The point is that the attempts
are *alternatives*, so nothing here merges: the winner's branch is kept exactly
as it stands and what happens to it afterwards is ordinary git work. Tori records
only the two things git has no field for, which group an attempt belongs to and
what the group was trying to do, and reconciles that record against git on every
read.

## How it works

**Attempts live inside the project root**, under one gitignored dot-directory
(`ATTEMPTS_DIR`, `attempts.rs:39`), not beside it where a bare container's
worktrees sit. A session whose cwd falls outside the discovered project root
fails `sessions::cwd_matches`, so an attempt built as a sibling would have its
sessions vanish from the tree entirely (see
[[concept_folder_anchored_sessions]]). The cost is that every walker over the
project skips one more directory, which is why `ATTEMPTS_DIR` is exported and
consulted by the watcher, search, quick-open and the checkpoint snapshot rather
than each inventing the name.

**Git is the truth; the map is only what git cannot say.** `list_attempts`
(`attempts.rs:116`) reads the per-project map and drops any entry whose worktree
git no longer lists, writing the reconciled map back. A read that writes is
unusual and deliberate: doing it lazily at the next promotion would render a
group that is already gone. If git cannot be read at all the recorded map is
returned untouched, because "git failed" and "every worktree was deleted" are
different answers and only one should empty the store.

**Creation could not reuse `create_worktree`.** That command builds beside a bare
container and links `.shared/` from its sibling; an attempt lives inside the
root. Removal *does* reuse `do_remove_worktree`, which is where the dirty guard
and the prune live, and `link_shared` is reused after the clone so a shared name
can never replace a cloned `node_modules`. See [[component_worktree_lifecycle]].

**Dependency directories are APFS clones** (`cp -c -R`, `CLONED_DIRS`), so three
attempts of a `node_modules`-bearing project are usable immediately at near-zero
disk cost. `-R` keeps symlinks as symlinks, which is the half that matters for
`node_modules/.bin`: those are relative links into sibling packages, so copying
them as links resolves inside the attempt.

**The surface reads the recorded map, never the directory name.** The frontend
could have treated any unit under the dot-directory as an attempt; matching
against `list_project_attempts` instead keeps the constant in one place and
preserves the backend's deliberate behaviour that an *unrecorded* leftover
surfaces as an ordinary worktree, which is recoverable, rather than as an
invisible one. The two project kinds present attempts completely differently: a
worktree container enumerates worktrees, so its attempts arrive as ordinary
branch-units and must be lifted out of the flat list or they render twice, while
a plain repo enumerates *branches*, so its attempts are not in the list at all
and the unit is synthesized from the record (`attempts.ts` `groupAttempts`).

## Why it's this way

**A promotion deletes; it never merges.** Merging alternatives is a different
feature with different failure modes, and `promotion_never_merges` reads the
module's own source and fails if merge, rebase or cherry-pick ever appears as a
git argument. Everything a loser owned goes with it: worktree, branch, sessions,
checkpoint refs and per-turn attribution files, because a leftover in any one of
them is a session pointing at a directory that is gone.

**Removal is forced, and the deliberate half is the confirm.** A losing attempt
is by definition work being thrown away, so the dirty guard would only obstruct;
the UI confirm counts what is still running under the losers and says the
deletion cannot be undone.

## Related

- [[concept_folder_anchored_sessions]] - why an attempt has to live inside the root
- [[component_worktree_lifecycle]] - removal is shared; creation could not be
- [[gotcha_du_cannot_see_an_apfs_clone]] - why disk cost must be measured as free space
- [[gotcha_git_prunes_an_ignored_directory_rather_than_descending_it]] - why no exclude pathspec was needed
- [[gotcha_the_sidebar_rail_is_a_variable_not_a_copy]] - how the group nests in the tree
- [[lesson_a_registered_command_with_no_caller_is_not_shipped]] - this phase's own defect
- [[concept_feature_workspace]] - the sidecar successor: same inside-the-root placement, but its reconcile marks a missing worktree instead of dropping the record
