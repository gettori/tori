---
summary: a Feature is a shared branch plus a sidecar record reconciled against git that never drops a member, even a broken one
status: current
updated: 2026-08-28
source: "Features: design the multi-repo workspace and open the epic (personal/tori, branch `feature-workspace`, issue #151, children #152 to #160), `src/App.tsx:278`, `src/panels/Editor/Editor.tsx:371,777`, `src-tauri/src/attempts.rs:116`, `src-tauri/src/worktree.rs:203`"
---

# ADR: A Feature is a shared branch plus a sidecar record, selected as its own workspace

**Status note:** accepted (implemented, #152 to #160 on branch `feature-workspace`)

## Context

Issue #151 asks for a cross-repository working context: one Git worktree per member repo, opened as one workspace with a unified explorer, search and changes view. Today `Selection` carries one `folderPath`, `App.tsx:278 wsKey()` and about twenty stores key on it, and `Editor.tsx:371 ws()` is `root() ?? ""`, so the workspace key and the root path are one string spelled two ways. Six backend surfaces take one root by signature. Nothing multi-root exists and `config.rs:653` collapses discovery roots to one on purpose.

## Decisions

- **Identity is a shared branch.** Every member gets `feat/<slug>`, slug from the Feature name and frozen at creation; the name stays free to change. One branch name across repos is what plain git shows and what the adopt flow keys on. Rejected: inferring Features from branches with no record (no order, display names or UI state), and renaming branches on Feature rename (a cross-repo git op, which this design keeps out entirely).
- **A sidecar record, reconciled against git, that never drops a member.** `~/.config/tori/features.json`, out of band like `attached.json` so writes never loop the config watcher. Every read runs `git worktree list` per member and rewrites a per-member `state` (present / worktree-missing / repo-missing / failed). This departs from `attempts.rs:116`, whose read prunes records: a Feature with a vanished member must render as a Feature with a broken member and a repair action, not as a smaller Feature. Rejected: a Feature folder on disk as the record (a Feature is not a directory, and its members live beside their own containers).
- **Worktree placement through one creation core.** `create_worktree`'s body becomes `create_worktree_in(repo, branch, target_dir)`; a worktree container passes itself (a Feature worktree there is an ordinary branch unit), a plain repo passes `<repo>/.tori/worktrees`, excluded via `.git/info/exclude` and inside the root so `sessions::cwd_matches` holds. Rejected: containers only (excludes most cloned repos), switching a plain repo's branch in place (breaks a repo in several Features), and copying `git worktree add` a third time (attempts already could not share creation; extracting the core ends that).
- **Feature selection is its own workspace key.** `Selection.kind = "feature"` with `roots[]` and an `activeRoot`; `wsKey` is `feature:<id>`. Layout, panes, editor and terminal tabs key on `wsKey`; git, the settings overlay, the watcher, tasks and PRs read `activeRoot`; the explorer, search and changes read `roots[]`. Path-keyed data (dirty flags, hot exit, local history) stays absolute and untouched. Rejected: the active member's `folderPath` as the key (every member switch would swap the strip and blank git, the opposite of one context).
- **One worktree, two homes.** A Feature worktree in a container is listed in Spaces with an `in <Feature>` chip; its tabs and sessions belong to the Feature group, and the unit's live-tab count reads that group. A plain repo's Feature worktree is not listed in Spaces (branch not attached) and its sessions attribute to the Feature member rather than re-homing onto the current checkout. Rejected: showing both tab groups on the unit.
- **Record first, then create sequentially.** The record is written with every member pending, worktrees are created one at a time (git's index lock), failures are recorded with a reason and retried from the item. Rejected: all-or-nothing creation. A pre-existing `feat/<slug>` prompts adopt or rename, which is also the path for adopting work that predates Features.
- **Repo identity is always shown inside a Feature.** A chip on every file and terminal tab, member sections in every grouped panel, the member as the first breadcrumb. Rejected: VS Code's collision-only folder suffix, because the strip must read the same with two repos and with ten.
- **Fan out the single-root commands and merge in TS.** `grep_project`, `git_status`, `list_project_files`, `fs_watch_start` stay single-root; the panels invoke per member and merge, with per-member truncation, backend capability and replace targets. Rejected: multi-root Rust commands, since the panels need per-member sections anyway.
- **Removal detaches and offers, never deletes silently.** Removing a member or deleting a Feature drops the record, then offers worktree removal per member behind the existing dirty and unpushed guards. Rejected: record and worktrees living and dying together.
- **No Feature-level settings overlay.** `loadWorkspaceSettings(activeRoot)` stays per member. Revisit if a real case appears.

## Consequences

- Phase 2 (#154) is the structural change: the `ws()` / `root()` split touches Editor, Terminal, Omnibox, SearchPanel and every workspace-keyed store. The consumer table in [[concept_feature_workspace]] is the contract for it.
- `gitActions.ts` stops being a one-slot store; the map of slots is what makes the Feature list's change count possible.
- Every walker that skips the attempts dir must also skip `.tori/worktrees`, or a plain repo's search and quick-open double-list the Feature's files.
- Deleting a Space that contains a member leaves a `repo-missing` member with a Locate action, by design.

## Related

- [[concept_feature_workspace]] - the record shape, reconciliation rule and the consumer table this decision commits to
- [[component_worktree_lifecycle]] - the creation core this extracts and the removal dialog it reuses
- [[adr_attached_branch_model]] - why a plain repo's Feature worktree is invisible in Spaces and how its sessions are attributed
- [[concept_fan_out_attempts]] - the sidecar precedent, and the drop rule this deliberately does not copy
- [[concept_path_keyed_workspace_stores]] - the stores that move to `feature:<id>`
- [[adr_sidebar_project_manager]] - the single-root discovery model a Feature sits beside, not inside
