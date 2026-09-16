---
summary: sidebar becomes the project manager rooted at one canonical root, worktree ops native, auth ops in a terminal tab
status: current
updated: 2026-07-31
source: Sidebar as Project Manager (personal/sway, branch code-mirror-6); commits 785b17b, afb4cc0, e49947a, 09ad986, e6f929f, 4f14660
---

# ADR: Sidebar as project manager

## Context

The sidebar had grown hover `+` buttons for a few create actions, multiple discovery roots, and no lifecycle management (worktrees, git init, recreated-folder sessions). We wanted the left pane to manage the whole git + AI workflow from a single canonical root, filesystem-truth driven and safe under live sessions, without a private agent API.

## Decisions

- **Single canonical root.** Discovery collapses any legacy multi-root config to the first root **in-memory on load** (not only on explicit reset), so the toml is never rewritten except by explicit mutation (`set_root`/`remove_root`). Reset **forgets only** (zero on-disk deletion). See [[component_project_discovery]].
- **Non-deletable "Other" section** for out-of-root pins (`[discovery].paths`), tagged by origin in `ResolvedConfig`; `pin_path` refuses a path inside the root. Reuses the space renderer under a divider.
- **Per-node context menus on all four node types**, via one portaled primitive; the hover `+` buttons are removed. Space creation for an empty tree and all root ops live in a gear menu. See [[component_context_menu]].
- **Native Rust for quick metadata ops** (root mutation, pin, `git_init`/`git_remote_add`, worktree create/remove); **a terminal tab for auth/destructive ops** (clone, bootstrap, first-commit, push) for native progress + ambient git auth, re-discovering on tab exit. See [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]]. **Superseded for auth by [[adr_git_integration_auth]]**: an askpass/editor bridge over system `git` replaces the tab as the auth mechanism (tabs stay optional for live progress).
- **Worktree folder = branch's last segment** with a slug fallback then a clean failure (never overwrite); `git fetch` before a new branch (base = origin default); the **`.link/` convention** (skip-if-exists, bare-container only) for shared files. See [[component_worktree_lifecycle]].
- **Recreated-folder sessions** gated by a separately-stored, idempotently-seeded `adopted_paths` set (never the watched toml), with auto-adopt for Sway-created folders. See [[component_session_scanner]].

## Amendment 2026-07-31: the sidebar stops at branches

The sidebar no longer lists sessions. Its tree is spaces → projects → branch
units, and a branch-unit row is a **leaf**: no disclosure, no fetch on click,
clicking it means exactly one thing, select this unit. Session navigation moved
to [[component_history_dropdown]], which is branch-scoped and reachable from the
surface the sessions actually run in.

What this removed, beyond the rows: the unseen dot
([[concept_unseen_stamp_bookkeeping]]), session archiving end to end, the
touched-file count, the branch-mismatch badge, and the sidebar's own calls to
the historical verdict (those belong to whatever renders the Historical section,
and that is now only the panel).

Two rules changed as a consequence rather than by decision. **Rollups count
unconditionally** - the old `hiddenOnly`/`statusVisible` guard existed so a
rollup would not double-report a session row that was already on screen, and
with no session rows anywhere it can never be a second report; call sites decide
which *rows* render. And **the filter matches project names only**, because
keeping the session half would hide whole projects on the strength of a title
you can no longer see.

The adopted-set / recreated-folder model is unchanged, but its surface moved to
the panel with everything else.

## Consequences

- The sidebar is the single control surface; the config toml stays non-destructive and loop-free (mutations are explicit and, for the adopted set, stored out of band).
- Removal is guarded against live use (dirty tree, running agents, open editor), so nothing is deleted from under an active session.
- **Deferred to handoffs:** folder/branch-unit renaming and convert-to-bare-worktree, both of which carry the session re-anchoring problem (moving Claude's lossy cwd-encoded jsonl + pi's path-based sessions), see [[gotcha_encoded_claude_dir_name_is_lossy]].

## Connections

- Governs [[component_project_discovery]], [[component_worktree_lifecycle]], [[component_context_menu]], and the adopted-set half of [[component_session_scanner]].
- Superseded at the session level by [[component_history_dropdown]] (2026-07-31).
- Builds on [[concept_filesystem_source_of_truth]] and [[concept_folder_anchored_sessions]].
- Complements [[adr_stack_choice]] (manual `sway.toml` + discovery).
