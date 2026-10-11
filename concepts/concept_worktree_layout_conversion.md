---
summary: a plain clone converts in place by staging its files, going bare, then adding the worktree, with a per-step journal for undo
status: current
updated: 2026-10-11
source: "gettori/tickets#74, convert a plain clone to the bare plus worktree layout (personal/tori, branch phase-1-block-2); src-tauri/src/convert.rs; commits 36635567, 42a2de53"
---

# Worktree layout conversion

"Convert to worktree layout" turns a plain clone at `<proj>` into `<proj>/.bare` plus a worktree at `<proj>/<branch leaf>`, in place, with no clone and no network. Staged, unstaged, untracked and ignored files, stashes, branches, remotes and the HEAD reflog all survive, so `git status`, `git stash list` and `git branch` read the same afterwards.

## How it works

`conversion_preview` answers a refusal (the `Err`) or a `Preview`: branch, leaf, target, and linked worktrees in three groups (Tori's under `.tori/worktrees`, nested elsewhere in the checkout, outside the project), plus the Topics whose reference will lack a default-branch checkout. Refusals: an operation in progress (rebase, merge, cherry-pick, revert, bisect), submodules, sparse checkout, `extensions.worktreeConfig`, `core.worktree`, detached or unborn HEAD, a Tori slug equal to the leaf.

`convert` then runs, in this order:

1. Writes a journal at `.git/tori-convert.json`.
2. Renames every top-level entry except `.git` into a visible `tori-converting-<leaf>` folder.
3. Moves `.git` to `.bare`, sets `core.bare`, writes `gitdir: ./.bare`.
4. `git worktree add --no-checkout <proj>/<leaf> <branch>`, which now succeeds (see [[gotcha_git_worktree_add_refuses_a_branch_the_main_checkout_holds]]) and names the admin dir after the leaf.
5. Moves the new `.git` file into staging and renames staging over the empty worktree folder.
6. Moves the old `index` and `logs/HEAD` into the admin dir, found by its `gitdir` backlink rather than by name.
7. Moves Tori worktrees out to `<proj>/<slug>`, repairs every linked worktree at its new path, prunes only after ([[gotcha_git_worktree_repair_before_git_worktree_prune_never_the_reverse]]), and repoints Topic members.
8. Deletes the journal.

The linked list is read raw from porcelain ([[gotcha_list_worktrees_body_hides_dot_folder_worktrees]]).

## Why it is this way

Files move before git is told anything because git refuses to add the worktree while the checkout still holds the branch, and a worktree added under a temporary name would keep that name as its admin id. Staging is visible so a crash never hides the user's files.

The journal records the last step begun and a `repointed` flag. Every undo step checks the disk before acting, so `undo` works from any point, including halfway through step 2. While a journal exists (in `.git` or `.bare`) the project probes as `converting` before any other classification, which keeps "Remove empty container" away from a half-built `.bare` ([[component_project_discovery]]).

The frontend refuses while any tab is live or any file unsaved (the quit stash included), then moves the editor state with [[concept_workspace_move]] instead of purging it. Earlier agent sessions stay keyed to the old cwd; the dialog says so rather than aliasing them.

## Related

- [[concept_workspace_move]] the frontend half
- [[component_project_discovery]] the `converting` kind
- [[adr_sidebar_project_manager]] native ops, and the deferred convert this delivers
