---
summary: feature store reconciles a member's state, never membership, and repair runs worktree repair before prune, not reversed
status: current
updated: 2026-08-28
source: "Features phase 0: the Feature record, reconciliation and worktree creation (personal/sway, branch `feature-workspace`, issue #152); commits 4f9c5ab, dc20290, d654cc9; Feature lifecycle, member management and repair (#159); commits 774704d, ef3779b, ede61ff, 70756f3"
---

# Feature store

**Location:** `src-tauri/src/features.rs` (mirror: `src/utils/features.ts`)

The backend of a Feature ([[concept_feature_workspace]]): the sidecar record in `~/.config/sway/features.json`, the read that reconciles every member against git, and the commands that create, repair and detach `feat/<slug>` worktrees across member repos. The UI half is [[component_feature_list]].

## Responsibilities

- Owns the record: `Feature { id, name, branch, members[], createdAt }`, `Member { repoPath, displayName, worktreePath, state, order }`, `MemberState` internally tagged (`{"kind":"present"}`, `{"kind":"failed","reason":"..."}`). Every optional field has a serde default, so an old file loads.
- Owns every write to the file. `Store::mutate` (`features.rs:105`) is load-edit-save under `exec::named_lock("features")`, and `list_features` (`:155`) takes the same lock around its own load-compute-save. The store is a handle `Store { path }` so every test runs on a temp file; nothing in the tests touches the home directory.
- Reconciles state, never membership. `reconcile_member` (`:179`) runs three checks in order: `worktree::repo_readable` (else `RepoMissing`), the recorded path `is_dir` and listed by `git worktree list` on `feature.branch` (else `WorktreeMissing`), and a `Failed` member with no path stays `Failed`. A read rewrites `state` only and saves only when something changed.
- Creates worktrees record-first. `create_feature` (`:363`) rejects a slug already in the store and a repo listed twice (by `exec::common_dir`, so a worktree of a member is the same member), writes the Feature with every member `Failed { "pending" }` (`PENDING`, `:27`), then `build_member` (`:337`) per member in input order: it first looks for a worktree already on the branch in `list_worktrees_body` and adopts a secondary one (a plain repo's main checkout fails with "checked out in place"), and only a branch with no worktree goes through `feature_container` plus `worktree::create_worktree_in`; then a separate `Store::mutate` flips that one member. A failure keeps git's reason and the loop moves on. `retry_member` (`:410`) and `add_member` (`:422`) are the same path for one member. `create_feature` and `add_member` take `on_step: &dyn Fn(&Feature)`, called after the record write and after each member, so progress is testable without an `AppHandle` (`on_step_sees_the_record_once_per_write`); the command layer's `step(&app)` (`:469`) emits `features://changed` with the Feature, while `retry_member` emits nothing and the list applies its answer.
- Decides placement. `feature_container` (`:291`) refuses an unreadable repo, returns a bare container itself, and for a plain repo returns `<repo>/.sway/worktrees` after `git::exclude_from_repo(repo, ".sway")` and `create_dir_all`.
- **Repairs a broken member, and converges (#159).** `build_member` runs `worktree::prune_worktrees` under the repo lock it already holds and then ignores any listed entry whose path is not a directory: git keeps listing a folder deleted outside Sway, so adopting that entry flipped the member `Present` at a path that is not there and the next read put it back to `WorktreeMissing`, which made Recreate a loop on its own subject ([[gotcha_git_keeps_listing_a_worktree_you_deleted_outside_it]]). `relocate_member` points a member at the repository it moved to, which is the one write that changes `repo_path`: it refuses a folder git cannot read and one another member already holds (by `common_dir`, so the member under repair is excluded from that check), re-points `worktree_path` when the worktree travelled **inside** the repo folder and leaves it alone otherwise, then runs `git worktree repair <new worktree>` and only afterwards prunes. That order is load-bearing: prune first and the admin entry of a checkout that is plainly still there is destroyed ([[gotcha_git_worktree_repair_before_git_worktree_prune_never_the_reverse]]).
- **Answers with the record, and announces it (#159).** The four record-only commands (`remove_member`, `reorder_members`, `rename_member`, `rename_feature`) take an `AppHandle`, reload and emit `features://changed` through `commands::announce`, and return the Feature. Before that they answered nothing and emitted nothing, so every consumer of `createFeatureMembers` kept the names and the order the window opened with, and only the sidebar looked right because it patched its own signal. A command that changed the world on disk answers through `reconciled_feature` (a `list_features` narrowed to one id) rather than `load_feature`, which clones the stored state, i.e. the state that command has just invalidated ([[gotcha_load_feature_answers_with_the_state_its_caller_has_just_invalidated]]).
- **Keeps at least one member.** `remove_member` refuses the last one with `LAST_MEMBER` (`:219`), a `pub const` the TS side mirrors as `features.ts` `LAST_MEMBER`, so the row menu draws the reason on a refusing Remove instead of waiting for the click to fail.
- Does NOT remove worktrees: `remove_member` and `delete_feature` detach the record only, and the UI offers the worktree afterwards through [[component_worktree_lifecycle]]. Does NOT rename branches on `rename_feature` (the branch is frozen at creation), and does NOT adopt sessions or evict probe caches in the core: `commands::settle` does both after a creating command, so the core stays testable. `relocate_member` uses `settle` rather than `announce`, since the repo folder changed and both paths' probe caches are stale.

## Key files & entry points

- `src-tauri/src/features.rs:443` `mod commands`: thin `#[tauri::command] async fn` wrappers over `exec::blocking`, registered in `lib.rs` as `features::commands::*` (`list_features`, `create_feature`, `retry_member`, `add_member`, `relocate_member`, `remove_member`, `reorder_members`, `rename_member`, `rename_feature`, `delete_feature`, `probe_feature_branch`). Two finishes: `announce` (reload, emit `features://changed`, answer) for a record-only write, `settle` (adopt sessions, evict probes, emit `config://changed`) for anything that touched git.
- `src-tauri/src/features.rs:434` `probe_feature_branch(repo, slug)` -> `{ local, remote, hasWorktree }` so a dialog can say "will reuse" or "checked out in place" before running anything.
- `src-tauri/src/worktree.rs:252` `create_worktree_in(repo, branch, container)`: the creation core this module calls; reuse returns the existing path, the main checkout of a plain repo errors.
- `src-tauri/src/fs.rs:521` `FEATURE_WORKTREES = (".sway", "worktrees")`: the parent-child ignore rule for `is_ignored`, `walk_files` and `search.rs:437` `plain_grep`; git-backed walkers rely on the exclude entry instead.
- `src/utils/features.ts`: the types, `featureSlug` (a regex mirror of `feature_slug`; the two test files share cases, keep them in step), `memberInitials`, `LAST_MEMBER` (the same string as the Rust const), `memberState`, which reads `Failed { "pending" }` as "Creating" with no action, and `REPAIR_LABEL` / `RepairAction`, the one naming of the three repairs `memberState().action` chooses between.
- `src-tauri/src/worktree.rs` `prune_worktrees(repo)`: best-effort `git worktree prune`, extracted so `do_remove_worktree`, `build_member` and `relocate_member` share it rather than each spelling it out.

## Connections

- Depends on [[component_worktree_lifecycle]] for `create_worktree_in`, `repo_readable`, `is_bare`, `branch_exists` and friends.
- Depends on `exec::named_lock`, `exec::repo_lock`, `exec::common_dir` and `owned_state::write_atomically`; same sidecar shape as [[concept_fan_out_attempts]] minus the prune.
- Used by [[component_feature_list]] (#153: every command, `features://changed` per step, `config://changed` at settle; #159: the member list's rename, reorder, repair and remove, and the delete sweep).
- Read by [[component_project_discovery]]'s probe indirectly: a plain repo's Feature worktrees are what `secondary_worktree_units` exists to surface as branch units.
- Governed by [[adr_feature_workspace]].

## Related

- [[concept_feature_workspace]] - the mechanism and the consumer table
- [[concept_workspace_settings_overlay]] - the `.sway` dir and `.git/info/exclude` precedent this reuses
- [[gotcha_git_worktree_list_answers_empty_for_a_vanished_repo]] - why `repo_readable` runs first in both reconcile and placement
- [[gotcha_grep_exclude_dir_matches_by_basename_only]] - why the plain grep flag is gated on the dir existing
- [[gotcha_git_worktree_list_reports_canonical_paths]] - the reconcile canonicalises both sides, tests canonicalise temp dirs up front
- [[gotcha_git_keeps_listing_a_worktree_you_deleted_outside_it]] - why `build_member` prunes and then filters on `is_dir`
- [[gotcha_git_worktree_repair_before_git_worktree_prune_never_the_reverse]] - the order `relocate_member` runs them in, and what the other order destroys
- [[gotcha_load_feature_answers_with_the_state_its_caller_has_just_invalidated]] - when to use `reconciled_feature` instead
- [[lesson_a_plan_names_a_mechanism_the_code_forbids]] - three of this module's tasks specified a mechanism the repo rejects
