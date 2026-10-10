---
summary: worktree creation is a shared core taking a target dir, so a plain repo's Feature worktree lands under .tori/worktrees
status: current
updated: 2026-10-10
source: Sidebar as Project Manager + Sidebar Context-Menu Redesign + Shared tab + Attach worktree + Add Branch/Worktree unify (personal/tori, branch code-mirror-6); commits 09ad986, dac1093, e704411, _shared-tab_, _attach-worktree_, _add-branch-worktree_; Features phase 0 (#152, branch feature-workspace); commit 4f9c5ab; Feature lifecycle, member management and repair (#159); commits ef3779b, ede61ff, 70756f3; gettori/tori#208 commit b25293df (create_pr_worktree_in); plan "Run a setup command when a worktree is created" on branch setup-command, ticket gettori/tickets#2
---

# Worktree lifecycle

**Location:** `src-tauri/src/worktree.rs` (frontend: `src/components/Sidebar.tsx`)

Create and remove git worktrees under a bare container from the sidebar, with a shared-file convention and live-use safety. A worktree "project" is a `.bare` container holding one folder per branch (see [[concept_folder_anchored_sessions]] / [[component_project_discovery]]); this component owns the mutation side of that layout.

## Create (`create_worktree`)

- **Folder naming** (pure `pick_worktree_folder`, unit-tested): the branch's **last path segment** (`bug/critical` → `critical`), falling back to a **sanitized full-branch slug** on collision (`bugfix/auth` → `bugfix-auth` when `auth` is taken), then a **clean error** if that also collides. Never overwrites an existing folder.
- **Existing branch** reuses its worktree if one exists (`branch_has_worktree`, no-op) or checks the branch out into the new folder. **New branch**: best-effort `git fetch` first (a repo without a remote simply has nothing to fetch), then `worktree add -b <branch> <target> <start>` where `<start>` (pure `new_branch_start_point`, unit-tested) is `origin/<branch>` when that remote branch exists (so it **tracks** it), else `origin/<default>`, else omitted (HEAD). Preferring the matching remote ref is what lets *Add Worktree* check out a remote-only branch, and it fixed the latent mis-basing when a typed name happened to match a remote branch (previously always based on the default). See [[gotcha_git_worktree_add_wont_check_out_a_remote_only_branch_by_default]].
- After add, links shared files (below), then emits `config://changed`. Also **auto-adopts** the new folder (see [[component_session_scanner]]) so reusing a path that once held sessions is not flagged historical.
- **Setup runs on a real creation only.** `add_worktree_in` does the work and answers the path plus whether it created the folder. `create_worktree_in` starts the project's setup command when it did ([[component_worktree_setup]]). `create_pr_worktree_in` calls `add_worktree_in` itself, checks the head first, and starts setup only when the head is on origin, never for a fork.
- **The core is `create_worktree_in(repo, branch, container)`** (`worktree.rs:252`, since #152): folder pick, add, `link_shared` relative to `container`, returning the worktree path. A branch that already has a worktree returns that path, except the main checkout of a plain repo (`is_main && !is_bare` in the porcelain list), which errors rather than being adopted. No adopt, no emit: the caller decides what the folder means. `create_worktree` calls it with `container = repo_path` and keeps its early `Ok(())` on reuse, so the command's behaviour is unchanged; [[component_feature_store]] calls it with `<repo>/.tori/worktrees` for a plain repo. `Worktree` also carries `is_bare` (the porcelain `bare` line) and `repo_readable(repo)` exists because `list_worktrees_body` answers an empty `Ok` for a deleted repo ([[gotcha_git_worktree_list_answers_empty_for_a_vanished_repo]]).

## Add Worktree (`addWorktree`, "Add Worktree")

One dialog (the worktree analog of the plain-repo **Add Branch**) that merges the former *New worktree…* + *Attach worktree…*: a creatable [[component_picker_modal]] listing branches with **no worktree yet** (local branches minus the container's worktree units, with remote branches folded in after a background fetch). Picking a listed branch **or typing a new name** both spawn a worktree - every result routes to `create_worktree`, which DWIMs the target (existing local → checkout, remote-only `origin/<name>` → tracking, brand-new name → branch off default; see above). It **reuses the attach machinery verbatim**: the mode-agnostic `attachCtx` routing map (`label → {kind, branch}`), `askPick(…, creatable)`, and the shared `git://fetch-done` remote fold; the map resolves a picked `origin/<name>` back to its bare branch, and a value absent from the map is the typed new name. The plain-repo `addBranch` shares this machinery but routes to `attach_branch` / `attach_remote_branch` / `new_branch`+checkout instead. The background-fetch kickoff (credential-helper warning + `git_fetch`) is factored into `beginBackgroundFetch`.

## `.shared/` shared files (`link_shared`, `SHARED_DIR`)

After a worktree is created, each top-level entry of `<container>/.shared/` is symlinked into the new worktree root, **skipping any name the worktree already has** (a tracked file is never clobbered; checked via `symlink_metadata`, which does not follow). Targets are absolute. It is a no-op when `.shared/` is absent. `.shared` never renders as a branch-unit because branch-units come from `git worktree list`, not a child-dir scan. The dir name is a single `const SHARED_DIR = ".shared"` (renamed from `.link` when the folder became editable, see [[component_cm6_editor]]). It is managed from the Worktrees section of the project settings dialog ([[component_project_settings_dialog]]); before that it was the Worktree settings page, and before the setup command joined it, Shared in worktrees.

**Sync is creation-only.** `link_shared` runs **only** from `create_worktree`; there is no relink pass. Editing `.shared` (via the Shared tab) after worktrees already exist does **not** propagate: a new worktree symlinks the then-current `.shared`, but adding/renaming/deleting a shared file afterward leaves existing worktrees untouched, so a deleted/renamed entry leaves a **dangling symlink** in already-created worktrees (accepted, not auto-pruned). The earlier "Update .links/" relink command (`relink_worktrees` / `relink_worktrees_pure`) was **removed** with this model.

## Remove (`remove_worktree`, `remove_worktree_and_branch`, `worktree_dirty`)

- **Dirty guard** (`tree_dirty`): refuses removal on tracked modifications or genuine untracked files, but **ignores untracked symlinks pointing into the sibling `.shared/`** (regenerable pointers, not user work). Without this a freshly linked worktree would read as dirty and be unremovable, see [[gotcha_shared_symlinks_read_as_untracked_and_block_worktree_removal]].
- `do_remove_worktree` (shared core, no emit): once `tree_dirty` passes, it kills a running setup in the folder, then `git worktree remove --force` (to drop the `.shared` symlinks git treats as untracked) then `prune_worktrees`. `remove_worktree` wraps it + emit (branch kept).
- `prune_worktrees(repo)` (#159): best-effort `git worktree prune`, extracted so the two Feature-side callers share it. `build_member` prunes before it reads the list, because git keeps listing a folder deleted outside Tori ([[gotcha_git_keeps_listing_a_worktree_you_deleted_outside_it]]); `relocate_member` prunes **after** `git worktree repair`, never before ([[gotcha_git_worktree_repair_before_git_worktree_prune_never_the_reverse]]).
- **`remove_worktree_and_branch`** removes the folder first, then `git branch -D`. It **emits `config://changed` *before* returning a `-D` failure**, so the tree refreshes (folder gone) and the frontend surfaces an explicit "folder removed, branch not deleted" message - the partial outcome is never swallowed.
- **Live-use guard (UI-side)**: the shared `worktreeRemovalBlock(u)` refuses removal when the worktree is the open editor root (`selected.folderPath` equals or is under it) or hosts a running agent, prefix-matching nested sessions via `list_sessions(worktree)` then `session_running` per id. Nothing is deleted when refused; used by both remove and delete+branch.

- **Automatic cleanup** is a third caller: the sweep in [[component_worktree_cleanup]] removes clean, merged or idle worktrees with `force: false`, after its own purge.

## The UI owes a purge first (`removeMemberWorktree`, #159)

`remove_worktree`'s own doc comment says the backend relies on the UI to tear down the PTYs and editor tabs under the folder before it runs, and every call site emits `PURGE_UNDER_PATH` first. Removing a Feature member and sweeping a deleted Feature's worktrees were two more such sites, which is exactly how that contract gets forgotten once, so both go through one helper:

`src/utils/memberWorktree.ts` `removeMemberWorktree(member, { branch, deleteBranch })` emits `PURGE_UNDER_PATH` for the worktree and then calls `remove_worktree_and_branch` or `remove_worktree` with `force: true` (the caller's dialog has already shown the warning). The purge is not undone by a rejection: a removal that failed still ran `git worktree remove --force` far enough to be worth not writing into, and the tabs come back on the next open. `src/utils/memberWorktree.test.tsx` pins the ordering and that failing case.

The sweep runs its rows under `Promise.allSettled` rather than a loop, so one repo refusing keeps its own worktree and nobody else's.

## Connections

- Extends [[component_project_discovery]] (the bare-container/worktree kind it mutates).
- Auto-adopts through [[component_session_scanner]]; guards on its `session_running` / `list_sessions`.
- Reached from [[component_context_menu]] (project Add Worktree / Add Origin; worktree unit Remove worktree / Delete worktree + branch).
- The `.shared/` folder is edited through the Shared tab of [[component_cm6_editor]].
- Realizes part of [[adr_sidebar_project_manager]] (worktree ops native, `.shared/` convention).

## Fan-out reuses removal, but could not reuse creation (2026-07-29; creation extracted 2026-08-25)

Since #152 the container-parameterised `create_worktree_in` above is exactly the extraction this section asked for; `attempts.rs` still calls plain `git worktree add` itself and can adopt the core later. The asymmetry below is kept as the record of why.

[[concept_fan_out_attempts]] creates several worktrees at once and deletes all
but one. It reuses `do_remove_worktree` outright, so the dirty guard, the
`--force` that drops regenerable `.shared/` symlinks, and the prune of the stale
admin entry are the shared ones, and `link_shared` is reused after the dependency
clone so a shared name can never replace a cloned `node_modules`.

**Creation could not be shared, and the asymmetry is real.** `create_worktree`
builds *beside* a bare container and links `.shared/` from its sibling. An
attempt has to live *inside* the project root, because a cwd outside the
discovered root fails `sessions::cwd_matches` and the attempt's sessions would
not appear under the project at all. So `attempts.rs` calls plain
`git worktree add` itself. Anything added to `create_worktree` that an attempt
also needs has to be added in both places, or extracted first.

One consequence worth knowing: an attempt's dependency clone copies from the
project root, so on a **worktree container** (whose root holds worktrees, not a
checkout) there is no `node_modules` to clone and attempts start without one.
"Usable immediately" holds for a plain repo.

## A worktree on a pull request's head

`create_pr_worktree_in` puts a local `pr-<N>` branch on a PR's head commit, which the caller has already fetched from the forge's PR ref (`refs/pull/N/head`, `refs/merge-requests/N/head`) because a fork's head is on no origin branch. A branch or worktree already at another commit is refused, never reset, so nothing done in it is lost. The path it returns for a reused worktree comes from `git worktree list`, so compare it canonicalized. `worktree.new` with `pr` drives it for the autopilot's review flow ([[adr_review_submit_pins_the_reviewed_head]]).

## Related

- [[adr_review_submit_pins_the_reviewed_head]] - the review flow the PR worktree serves
- [[component_feature_list]] - the two dialogs that call `removeMemberWorktree`, and the `keepLabel` `WorktreeRemoveDialog` grew for the first of them

- [[gotcha_shared_symlinks_read_as_untracked_and_block_worktree_removal]]
- [[gotcha_git_worktree_list_reports_canonical_paths]]
- [[gotcha_mtime_cache_must_key_on_dir_mtime_and_head]]
- [[adr_feature_workspace]] - the decision behind `create_worktree_in`; the removal dialog is reused as the offer on member removal
- [[component_feature_store]] - the second caller of the creation core
- [[component_worktree_setup]] - the setup command a created worktree runs, and the run a removal kills
- [[component_worktree_cleanup]] - the automatic sweep, the third removal caller
