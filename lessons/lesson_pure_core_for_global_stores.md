---
summary: split a command touching a global json store into a pure core taking state explicitly plus a thin load save emit layer
status: current
updated: 2026-07-09
source: Sidebar Context-Menu Redesign (personal/tori, branch code-mirror-6); `src-tauri/src/config.rs`, `src-tauri/src/worktree.rs`; commits 17a334a, dac1093, e704411
---

# Extract a pure core from commands that touch a global store

## What happened

The attached-branch work needed `#[tauri::command]`s that read/write a **global** JSON store (`~/.config/tori/attached.json`) and shell out to git. Testing them directly would either clobber the developer's real store (not hermetic) or need `State<ProjectIndex>` wiring a test can't easily build. Rust runs tests in parallel threads of one process, so an env-var override of the store path would race between tests, and there was no config-dir indirection to hook.

## Why

A command couples three things a test doesn't want: the global filesystem store, the Tauri `State`/`AppHandle`, and the `config://changed` emit. The durable logic (the seed rule, the branch intersection, the tracking-branch creation, the relink walk) is buried inside that coupling. This mirrors the pre-existing `adopted.json` design (`do_seed` was already a pure step), which is the precedent to follow, not reinvent. See [[component_project_discovery]].

## What to do next time

Split the command into a **pure core** that takes state/inputs explicitly and a thin command wrapper that just does load → core → save/evict/emit:

- `do_seed_attached(state, key, locals, seed) -> bool` (mirrors `do_seed`) — seed rule, tested in-memory with zero fs.
- `plain_branch_units(path, &attached)` — pass the attached set in, don't read the store inside; the discovery test then feeds controlled sets and stays hermetic (a store lookup for a random temp path returns nothing anyway).
- `ensure_local_tracking(path, name)` / `relink_worktrees_pure(container)` — the git-side logic without the store/emit, exercised against a real temp repo.

Test the core; let the command be the trivial glue. Bonus: a pure function makes the "never seed against empty", "never clobber a local branch", and "only current + attached are visible" rules obvious and individually assertable. Keep the store read at one boundary (`probe_project` loads `attached.json` once and passes it down), never scattered through the logic.

## Related

- [[component_project_discovery]] — the discovery probe and the attached-store commands this pattern backs
- [[adr_attached_branch_model]] — the out-of-band store decision that created the testability need
- [[gotcha_git_worktree_list_reports_canonical_paths]] — a trap the `relink_worktrees_pure` extraction surfaced
