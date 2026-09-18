---
summary: discovers spaces from disk and probes each repo's git kind with a cache keyed on dir and HEAD mtime, or it goes stale
status: current
updated: 2026-08-28
source: "Worktree-aware tree + Sidebar as Project Manager + Sidebar Context-Menu Redesign + Delete Group + Space icons & reordering (personal/tori, branch code-mirror-6); commits 5c5177f, 3501d59, 8ceb6e2, 785b17b, e49947a, e6f929f, 17a334a, e704411, fef06e6, bcd31db, 68920f0; Feature lifecycle, member management and repair (issue #159, branch `feature-workspace`); commit ef3779b"
---

# Project discovery & setup

**Location:** `src-tauri/src/config.rs`, `src-tauri/src/git.rs` (frontend: `src/panels/LeftSidebar/LeftSidebar.tsx`, `src/components/Dialogs/SpaceDialog.tsx`, `src/components/Icon/iconRegistry.ts`, `src/panels/Terminal/TerminalView.tsx`)

Discovers projects from the filesystem (replacing declared `[[project]]` entries), classifies each by its git layout, and provides the onboarding + create/clone/bootstrap + git-lifecycle commands. `get_config()` returns `{path, roots, spaces[]}` where each space is `{name, path, projects[], external, icon?}` (root spaces sorted by the user's saved order) and each project carries `branchUnits[]` + `external` (see [[concept_folder_anchored_sessions]]). It is the discovery/mutation hub the sidebar drives (see [[adr_sidebar_project_manager]]).

## Discovery model

- **A plain repo lists the worktrees it contains (#159).** `probe_project`'s no-bare branch returns `plain_branch_units` **plus** `secondary_worktree_units`, one `ProjectKind::Worktree` unit per `git worktree list` entry after the main worktree that sits **inside** the main worktree's own folder. Without it a Feature worktree kept in a plain repo was invisible in Tori: `plain_branch_units` enumerates `git branch` and keeps only the current checkout and attached names, and the walkers skip `.tori/worktrees` ([[gotcha_a_plain_repo_does_not_list_its_secondary_worktrees_as_branch_units]]). Containment, not merely non-main: a linked worktree beside its repo is a project in its own right and would otherwise list under that repo *and* be probed as itself. The test runs against git's own path for the main worktree, not the probed path, so a symlinked space root cannot make it silently match nothing. A branch a plain unit already names is skipped, so an attached branch checked out elsewhere yields one row, not two.
- **Single canonical root.** `[discovery].roots` collapses to the **first** root **in-memory on load** (`roots.iter().take(1)`), so a legacy multi-root config yields one tree, not two, without rewriting the toml. Scanned as `<root>/<space>/<project>`; dotfiles and `[discovery].ignore` names skipped. **Empty space dirs are surfaced** so a freshly created space is selectable.
- **Extra paths** (`[discovery].paths`, space = parent dir) + **legacy `[[project]]`** folded in. Migration is **in-memory** - the toml is never rewritten except by explicit mutation, so it is non-destructive and dodges the self-write echo.
- **Origin tagging.** Spaces/projects carry `external: bool` (root-discovered vs pinned via `paths`). `ensure_space_idx` keys on name **and** origin, so a root space and a pinned space of the same name stay distinct - the UI renders externals under a non-deletable "Other" divider.
- **Dedup** by canonical path (a project reachable via several roots/paths appears once; the root section runs first, so root wins).
- No default root: an empty config yields empty `roots` + `spaces`, which the UI reads as a first run.

## Space metadata overlay & order

Spaces stay **filesystem-derived** (the folder name is the immutable title); `tori.toml` only overlays optional metadata, keyed by name, merged at the end of `resolve` (mirrors the pin overlay + [[concept_filesystem_source_of_truth]]).

- **Icon.** `[[space]]` tables (`{name, icon?}`, `RawConfig.space`) carry a Lucide icon name (PascalCase, from the frontend `iconRegistry`'s fixed 40). Overlaid by name only, so a root space **and** a same-named external pin share the one entry. Blank icons are ignored. The tile renders `resolveIcon(icon)` when set, else the name's initial letter.
- **Order.** A flat top-level `space_order = [names…]` (`RawConfig.space_order`) sets the root-space order. `resolve` **stable-sorts** with key `(external, index-in-order)`: externals sort after all roots (key `.0 = 1`) and keep their relative order; a listed root sorts by its `space_order` index; an unlisted/new root shares `usize::MAX` and so keeps discovery order after the listed ones. **Pinned spaces are never reordered.**
- **Writes (pure cores + `toml_edit`).** `add_space(root, name, icon?)` is a **single command**: `mkdir` + (when `icon` is `Some`) write the `[[space]]` entry + its one `config://changed` emit, so a new space paints once with no letter→icon flash and no folder-exists-but-metadata-failed window. `set_space_meta(name, icon?)` is the **edit path only** (creates no folder): a blank icon normalizes to `None` and **prunes** the entry (dropping an emptied array-of-tables). `set_space_order(names)` replaces the order array (empty prunes the key). All three go through pure, comment-preserving `toml_edit` cores (`upsert_space_meta`, `write_space_order`) unit-tested without the real config (like the other pure cores, [[lesson_pure_core_for_global_stores]]); the write path mirrors `pin_path` (write → emit, no cache evict since icons/order don't touch the probe cache). See [[gotcha_vitests_node_env_gives_solid_js_its_server_build]] for the test-harness trap importing the icon registry surfaced.

## Git kind probe (cached)

`probe_project` runs `git worktree list --porcelain` once per project → `worktree` / `plain` / `plain-dir` / `incomplete` with its `branchUnits` (see the concept). Cached per project dir, **invalidated by `(dir mtime, HEAD mtime)`** where HEAD is `.git/HEAD` (plain) or `.bare/HEAD` (worktree container); a `git checkout` changes HEAD's mtime → cache miss → fresh `isCurrent`. See [[gotcha_mtime_cache_must_key_on_dir_mtime_and_head]].

A **plain** repo no longer lists every local branch: `plain_branch_units(path, &attached)` emits `list_branches ∩ (attached ∪ {current})`, keeping the "no branches → single folder unit" fallback. The attached set is the out-of-band `attached.json` store, loaded once at the `probe_project` boundary and **passed in** (the function is pure, for hermetic tests - see [[lesson_pure_core_for_global_stores]]). Attach/detach/delete/new-branch **evict this cache** after writing the store (attachment touches neither dir- nor HEAD-mtime), ordered store → evict → emit. See [[adr_attached_branch_model]].

## Onboarding & mutation commands

- `pick_folder` - native macOS folder picker via `osascript` (no Tauri dialog plugin); `None` on cancel. See [[gotcha_native_folder_picker_via_osascript]].
- **Root ops** (single-root model): `set_root` replaces `[discovery].roots` with exactly `[path]` (pure `replace_root`), `remove_root` clears it (pure `clear_root`); both preserve `paths` and legacy `[[project]]`. Reset **forgets only** (no on-disk deletion). Driven from the gear menu beside the search box.
- **Pins**: `pin_path` appends to `[discovery].paths` (pure `add_path`, idempotent) but **refuses a path inside the root** (`is_inside`: canonical when both exist, else a component-wise `PathBuf::starts_with`); `unpin_path` removes it (pure `remove_path`). Renders the "Other" section.
- `add_space(root, name, icon?)` / `add_folder` - mkdir under the root / a space; `valid_name` rejects empty, `/`, `\`, and leading-dot (incl. `..`); collisions rejected; emit `config://changed`. `add_space` also writes the optional icon in the same command (see **Space metadata overlay & order** above); `set_space_meta` / `set_space_order` handle later edits. `add_folder` auto-adopts (see [[component_session_scanner]]).
- `cleanup_incomplete` - removes an `incomplete` stub, **refusing anything that does not probe as incomplete**.
- `delete_space` - permanently `rm -rf` a **root** space and everything under it (`remove_dir_all` + `config://changed`). Guarded by the pure `do_delete_space`: canonicalize root and target, accept only when the target's parent **is** the collapsed single root (`take(1)` + `expand_tilde`), refusing the root itself, `$HOME`, and any non-direct-child or outside path (a symlinked space resolving outside the root is refused, never followed). Non-atomic: a mid-delete failure leaves a partial folder, surfaced as an error. The destructive typed-name confirmation + live-teardown live in the UI (see [[component_context_menu]]).
- `space_delete_preview` - read-only blast-radius for the confirm dialog: enumerates **every** direct child of the space (loose files and non-git folders discovery skips are surfaced too, not just projects), tagging each `repo`/`folder`/`file`. Per repo, `dirty` = any worktree has `status --porcelain` output; `unpushed` = any local branch is ahead of, or has no, upstream (`for-each-ref … %(upstream)/%(upstream:track)`, so a worktree-less branch's commits still surface). Plus a recursive `dir_size` (symlinks skipped). Advisory only, so best-effort is fine.
- `rediscover` - emits `config://changed`. `roots_watch_start` - a **shallow, non-recursive** watch of roots + their immediate space dirs; re-installed on every `loadConfig`, so a `set_root`/`remove_root` tears down the old watch and installs the new.

## Native git lifecycle (plain-dir → plain)

Native, fast, no-auth git ops in `git.rs` (auth/destructive ops go to a terminal tab instead, see [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]]). **The no-auth/tab split is superseded by [[adr_git_integration_auth]]**: an askpass + editor bridge over system `git` lets even auth'd ops run natively/backgrounded, so the tab is no longer the auth mechanism.

- `git_init` - `git init` (+ optional initial branch via `symbolic-ref`, see [[gotcha_rev_parse_abbrev_ref_head_returns_head_on_an_unborn_branch]]) and scaffolds a default `.gitignore` (node_modules, dist, build, target, .env, …) when absent; re-discovers as `plain`.
- `git_remote_add` - add or `set-url` `origin`. `git_origin` - origin URL or `None`, so the UI can gate the remote menu row (frontend caches this per project in an `origins` signal, see [[component_context_menu]]).
- (Commit all / Push were dropped in the menu redesign; their commands were removed.)

## Attached-branch commands (plain repos)

`list_remote_branches(repo)` sits beside `list_branches`: it lists `origin/*` via `git for-each-ref refs/remotes/origin`, drops the `origin/HEAD` symref, and returns short names **without** the `origin/` prefix. It feeds the Add Branch / Add Worktree picker's post-fetch remote-branch fold (see [[component_askpass]]).

The store lives in `config.rs` beside `plain_branch_units` / `ProjectIndex` / `list_branches`, because the writers need `State<ProjectIndex>` to evict the probe cache:

- `seed_attached(repo)` - seed the visible set once (origin default else current), **quiet**: not in the evict/emit writer set, so it persists for the next natural re-probe rather than forcing a render (mirrors `seed_adopted`). Skips an empty repo; the flag survives detach-to-empty.
- `attach_branch` / `new_branch` (create at HEAD, then a same-commit checkout with no confirm) / `detach_branch` (hides, git untouched) / `delete_branch` (`git branch -D` + prune). All order **write store → `ProjectIndex::evict` → emit**; detach/delete keep only a current-checkout guard. `addBranch` drives them from one creatable [[component_picker_modal]] (`askPick(…, creatable)`): a listed pick attaches (local/remote), a typed new name runs `new_branch`+checkout.
- `attach_remote_branch` - native, on already-fetched refs: `ensure_local_tracking(path, name)` creates `git branch --track <name> origin/<name>` when absent, rejects a missing `origin/<name>`, never clobbers an existing local branch. The **auth'd fetch is decoupled** (runs `git fetch --all` in a tab, see [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]]); the attach is a separate op that cannot cross the tab boundary.

The pure cores (`do_seed_attached`, `plain_branch_units`, `ensure_local_tracking`) are unit-tested in isolation, see [[lesson_pure_core_for_global_stores]].

## Clone & bare-worktree bootstrap

Both run **in a terminal tab** (Sidebar emits `OPEN_TERMINAL` → `TerminalArea` → `pty_spawn`) for native git progress + ambient auth, and re-discover on the tab's `pty://exit`. Clone = `git clone <url> <name>` after a free-path pre-check. Bootstrap = a fixed `set -e` pipeline (`git clone --bare` → `.git` pointer → fetch refspec → `git fetch` → default from the bare's HEAD → `git worktree add`) with a `|| rm -rf` cleanup; url/name pass as positional `$1`/`$2`. See [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]].

## Connections

- Produces the payload for [[concept_folder_anchored_sessions]].
- Sibling of [[component_session_scanner]] (projects vs sessions), both implement [[concept_filesystem_source_of_truth]].
- Mutated from [[component_context_menu]] (per-node actions + gear menu); worktree ops split out to [[component_worktree_lifecycle]].
- Governed by [[adr_sidebar_project_manager]] and [[adr_attached_branch_model]] (the attached-set discovery model); supersedes the manual-`tori.toml` half of [[adr_stack_choice]].

## Related

- [[adr_attached_branch_model]]
- [[lesson_pure_core_for_global_stores]]
- [[gotcha_mtime_cache_must_key_on_dir_mtime_and_head]]
- [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]]
- [[gotcha_native_folder_picker_via_osascript]]
- [[gotcha_rev_parse_abbrev_ref_head_returns_head_on_an_unborn_branch]]
- [[gotcha_vitests_node_env_gives_solid_js_its_server_build]]
