---
summary: sidebar context menu now rides Kobalte, preloading git origin since a synchronous menu build cannot await it
status: current
updated: 2026-08-15
source: Sidebar as Project Manager; Sidebar Context-Menu Redesign; Delete Group; Combine group create actions into one New dialog (personal/tori, branch code-mirror-6); commits afb4cc0, 03849c5, 17a334a, dac1093, e704411, fef06e6
---

# Sidebar context menu

**Location:** the primitive is now `src/components/Menu/ContextMenu.tsx` (wiring: `src/panels/LeftSidebar/LeftSidebar.tsx`; modals: `src/components/ConfirmDeleteSpace.tsx`, `src/components/NewProjectDialog.tsx`)

A generic, portaled right-click menu that drives every per-node action in the sidebar, replacing the old hover `+` buttons. Sibling primitive of [[component_overflow_tab_bar]] (both portal a dropdown out of a clipping ancestor).

## The primitive (superseded)

**The hand-rolled primitive this page described is gone.** #103 moved every menu in the app onto Kobalte: see [[component_menu]] for the surface, and [[concept_menu_trigger_wrapping]] for the sites (the space tile among them) whose control already belonged to a tooltip and had to be wrapped. What changed here is mechanism only, not contents: the rows below are the same rows.

What it was, for reading old commits: a caller-held `MenuState { x, y, items }` signal set on `contextmenu` and cleared on close, portalled out of `tree-scroll`'s `overflow:auto` ([[gotcha_overflow_hidden_on_a_positioned_bar_clips_its_own_dropdown]]), fixed-position and cursor-anchored, viewport-clamped after mount, dismissed on Escape and outside `mousedown`. Kobalte owns all of it now, and the `!items.length` bail that guarded an empty menu turned out to be unreachable and was deleted rather than ported.

Two consequences for anything reading this page while writing a test: nothing here answers a plain click any more ([[gotcha_a_kobalte_menu_answers_no_plain_click]]), and each row owns its own menu, so a second right-click no longer replaces the first implicitly.

## Per-node wiring (`Sidebar.tsx`)

Menus are built **synchronously** per node type, now by the row's own `items` rather than by a shared `openMenu(e, items)`:

- **gear** (top-right, empty-tree + global ops) - New space · Pin folder to "Other" ─── **Add/Update root** · Reset root. The two root ops sit together below a `.gear-divider`.
- **space** - New… ─── **Delete space** (`danger`, last row, root spaces only; external "Other" spaces get none). The single **New…** row opens `NewProjectDialog` (see "New… dialog" below); Delete space is covered below.
- **project** - keyed by `projectKind`:
  - **plain** - Add Branch ─── without an origin, `Add / set remote…` (with an origin, remote branches fold into the Add Branch picker after a background fetch).
  - **worktree** - `Add Origin` without an origin · Add Worktree.
  - **plain-dir** - Initialize git repo…; **external** - Unpin.
- **branch-unit** - New session (`selectUnit`); then by kind:
  - **plain** - ─── Checkout · Detach Branch · Delete Branch (Detach/Delete hidden on the current checkout and on the branchless folder-fallback unit).
  - **worktree** - ─── Remove worktree · Delete worktree + branch.
  - **incomplete** - Remove stub only.
- **session** - New session / Rename / Archive-Unarchive / Delete (existing overlay commands).

**Async-gated items in a sync menu.** The remote rows depend on `git_origin`, which is async, but a menu is built synchronously in `onContextMenu`. So origin state is pre-loaded **fire-and-forget** into an `origins` signal (`Record<projectPath, bool>`, one parallel `git_origin` per plain/worktree project) during `loadConfig` and read synchronously via `hasOrigin(p)` at open time - the same shape as the `historical` signal. A right-click in the brief window before it resolves shows the no-origin variant, self-correcting on the next load. The attach/detach/delete/new-branch actions call the `config.rs` store commands (see [[adr_attached_branch_model]], [[component_project_discovery]]); Fetch All emits `OPEN_TERMINAL` (auth'd fetch in a tab), attach-remote-branch is a separate native op.

Space creation for an **empty tree** stays in the gear menu (there is no space row to right-click); root ops live there too (see [[component_project_discovery]]).

## New… dialog (`NewProjectDialog`)

The space menu’s one create row opens `NewProjectDialog`, reusing the `.modal-*` chrome plus a `.seg` segmented control. A single dialog folds the three former rows (New folder / Clone repoâ¦ / Bare + worktreeâ¦): the segment picks a **mode** (`folder` | `clone` | `bare`), a Name field is always shown, and a Repository URL field appears only for clone/bare (auto-filling the name from the URL until it is hand-edited). `confirmNewProject` routes by mode: `folder` â the native `add_folder` invoke (busy-gated, dialog stays open on error); `clone`/`bare` â `runInTab` into a terminal tab (native git progress + ambient auth, see [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]]). This is an instance of the recurring [[lesson_menu_items_into_mode_picker_dialog]] pattern (its sibling is `InitGitDialog` on the **plain-dir** project row).

## Delete space (typed-confirm + teardown)

The space menu’s last (`danger`) row opens `ConfirmDeleteSpace`, a GitHub-style modal reusing the `.modal-*` chrome. It lists **every** child of the space (from `space_delete_preview`, see [[component_project_discovery]]) with dirty/unpushed badges, an advisory running-agent count, and disk size, and enables **Delete** only when the exact space name is typed (exact, case-sensitive; Enter is a no-op until it matches). Names render immediately from tree data; flags/size fill in when the async preview resolves.

Deletion is **warn-allow**, not blocked on live use (unlike worktree removal's guard). That trade means teardown is mandatory: on confirm the sidebar emits a `PURGE_UNDER_PATH` window event **before** the native `delete_space`, so no agent keeps writing into a vanishing cwd. `TerminalArea` kills + closes PTY tabs whose cwd is under the space (`pty_kill`); `EditorPane` force-closes buffers under it (no per-file dirty prompt); the active selection is cleared if it pointed inside. The running-agent count uses `list_sessions{folder}` prefix-match, **not** the rendered nodes (see [[gotcha_counting_live_agents_by_tree_nodes_misses_subdir_agents]]); the shared `isUnderPath` prefix rule lives in `src/pathScope.ts`.

## Connections

- Renders through [[component_menu]] since #103; the primitive section above is history.
- Sibling of [[component_overflow_tab_bar]] (portaled dropdown pattern).
- The action surface for [[component_project_discovery]], [[component_worktree_lifecycle]], and [[component_session_scanner]].
- Realizes the per-node-menu decision in [[adr_sidebar_project_manager]] and drives the attach/detach/delete/new-branch actions of [[adr_attached_branch_model]].

## Related

- [[gotcha_overflow_hidden_on_a_positioned_bar_clips_its_own_dropdown]]
- [[adr_attached_branch_model]]
- [[lesson_menu_items_into_mode_picker_dialog]] — the collapse-rows-into-one-dialog convention this menu follows
