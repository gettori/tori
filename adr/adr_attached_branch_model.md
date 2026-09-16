---
summary: plain repo branches show only when explicitly attached, and an orphaned session re homes rather than vanishing
status: current
updated: 2026-07-09
source: Sidebar Context-Menu Redesign (personal/sway, branch code-mirror-6); commits 03849c5, 17a334a, dac1093, e704411
---

# ADR: Plain-repo branches are explicitly attached, not all-listed

## Context

The sidebar listed every local branch of a plain repo as a branch-unit, which is noisy for repos with many branches. We chose an explicit **attach/detach** visibility model instead: a plain repo shows only branches the user attached (plus the current checkout), so the list stays lean and intentional.

## Decisions

- **Out-of-band store.** Attachment lives in `~/.config/sway/attached.json` (repo path -> {branches, seeded}), mirroring the `adopted.json` pattern - kept out of the watched `sway.toml` so writes never loop the config watcher. Discovery emits `list_branches ∩ (attached ∪ {current})`, starting from real branches so a stale entry never yields a phantom unit.
- **Per-repo seeded flag**, distinct from "set is empty", seeded once (origin default else current) and skipped until the repo has a branch, so detaching to empty is never silently re-seeded.
- **Detach hides, Delete removes.** Detach drops a branch from the visible set (git untouched); Delete runs `git branch -D` and prunes the store. Both keep only a current-checkout guard.
- **No session is ever orphaned.** A Claude session whose recorded branch has no visible unit re-homes onto the current-checkout unit (or the folder-fallback unit when HEAD is detached/unborn), so attach/detach/delete never hide history - which is why detach/delete need no session guard.
- **Writers evict the probe cache** (`config.rs` `cached_probe` keys on dir+HEAD mtime, which attachment does not touch), ordered store -> evict -> emit, or the tree would not re-render. See [[gotcha_mtime_cache_must_key_on_dir_mtime_and_head]]. **Seeding is the exception**: `seed_attached` is quiet (not in the evict/emit set), so its origin-default seed appears on the next natural re-probe, matching `seed_adopted`.
- **New Branch is quiet and cache-correct.** Creating a branch (`git branch` at HEAD) attaches it and evicts the cache on creation, independent of the follow-up switch; the switch is a **same-commit checkout**, so it changes no files and skips the "changes the shared working tree" confirm.
- **Fetch and attach are decoupled across the tab boundary.** The auth'd fetch runs `git fetch --all` in a terminal tab; `attach_remote_branch` is a separate native op on already-fetched `origin/<b>` refs (never clobbering an existing local branch). A single-shot fetch-then-attach can't cross the tab boundary, so it was rejected. **Superseded by [[adr_git_integration_auth]]**: with an askpass bridge the fetch runs backgrounded (no tab), so a unified fetch-then-attach picker becomes viable.
- **Testability drove a pure-core split** (`do_seed_attached`, `plain_branch_units(path, &attached)`, `ensure_local_tracking`) so the global-store logic is unit-tested without touching `~/.config`. See [[lesson_pure_core_for_global_stores]].

## Consequences

- Plain repos gain a persisted, per-repo UI-visibility concept that discovery must intersect on every probe; a new writer that forgets to evict the cache will silently no-op in the tree.
- The show-all + delete-from-git alternative was rejected: it forces destroying a branch just to declutter the list, and loses the branch. Attach/detach separates visibility from existence.

## Related

- [[component_project_discovery]] - the discovery probe that intersects the attached set
- [[component_context_menu]] - the menus that drive attach/detach/delete
- [[concept_folder_anchored_sessions]] - why sessions re-home rather than vanish
- [[lesson_pure_core_for_global_stores]] - the testability pattern the out-of-band store forced
- [[adr_sidebar_project_manager]] - the broader sidebar-as-project-manager decision this extends
- [[adr_feature_workspace]] - why a plain repo's Feature worktree (branch not attached) is invisible in Spaces, and the one attribution change it needs
