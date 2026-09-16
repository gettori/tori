---
summary: terminal tabs group by branch unit folder, with synthetic keys for shell and feature tabs, one pane stays active
status: current
updated: 2026-09-06
source: "Per-workspace terminal sessions, shell-hosted agents, and plain shell tabs (personal/sway, branch `topbar`), commits 0e671b1 (grouping + focus-or-resume), 3e8acd6 (live-tab surface), `src/panels/Terminal/Terminal.tsx`, `src/utils/events.ts`, `src/App.tsx`, `src/panels/LeftSidebar/LeftSidebar.tsx`, workspace-scoped `active` and the memoized derivation layer from \"Worktree and tab switching at native speed\" (branch `unified-tab-bar`, phases 3 and 4, commits 7d05710, f16b6ae); `kind: \"command\"` removed by plan \"Jobs: transient command terminals leave the tab model\" (branch `bugfix-260903`), commit `3a9f882`, _2026-09-03_, then revived under a synthetic key by plan \"Standalone terminals: Sway's own commands as tabs in a Shells workspace\" (branch `standalone-terminals`, issue #166), commits `30f1ea9` and `dd5c029`, _2026-09-06_"
---

# Per-workspace terminal tab grouping

How the terminal area groups, shows, and resumes its [[concept_shell_hosted_tabs]]. **Grouping key = the branch-unit folder** (`workspace`), so worktrees group per branch, plain-repo branches share one group, and a nested-cwd session still groups with its branch unit (not its own cwd).

## State model

The old flat `open[]` + single `active` became:

- `open: OpenTerm[]` — every tab, each carrying `workspace` (= `selected.folderPath` at spawn), `kind`, soft `sessionId`, `init`. **A `workspace` is not always a folder.** A clone, bootstrap, install or sign-in used to be a command tab keyed on its own cwd, which is not a branch unit; `paneTabs` dropped it from every strip and `focusTab` hid the real group behind it. [[adr_jobs_leave_the_tab_model]] took these out of the model, and this ticket brought them back under a **synthetic key** instead: `kind: "command"` tabs carry `workspace: "shells:"`, which no branch-unit selection ever equals, so neither failure can recur. `OpenTerminal.kind` still only ever means `"task"`; command tabs arrive through `OPEN_JOB`. The two synthetic keys are `shells:` ([[component_shells]]) and `feature:<id>` ([[concept_feature_workspace]]).
- `activeWorkspace` — the group currently on screen (driven by `props.selected.folderPath` only, now that no tab kind can move it out from under the user).
- `activeByWorkspace: Record<ws, tabId>` — the remembered focused tab per group.
- `visibleId()` — the single visible tab: the group's remembered tab, else its **first** tab when that record is unset or points at a closed tab (the active-tab fallback, so a revealed group is never a blank stage).

## Bar vs stage (gotcha #64)

The [[component_overflow_tab_bar]] gets `items={workspaceTabs()}` — the active group only. The stage's `<For each={open()}>` renders **all** tabs, always mounted, CSS-hidden unless `visibleId() === t.id`, so a hidden group's PTYs keep running. This obeys [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]]: `mergeReorder` splices the active group's reordered subset back over the same slots in `open[]`, preserving every object ref. And the empty message is an **overlay**, not a `<Show fallback>` around the `<For>` — see [[gotcha_an_always_mounted_for_gated_behind_a_show_fallback_unmounts_every_row]].

## Focus-or-resume (Option A, best-effort)

Selecting anything reveals its `folderPath` group (a **branch-row selection reveals only — no spawn**). A session selection then:

1. If a tab already carries that soft `sessionId` → **focus it** (no duplicate). If `session_running(sessionId)` reports the agent has exited to its shell, retype the resume via `pty_write` to bring it back **in place**.
2. Else → spawn a fresh resume tab (id = generated `sh:<ts>:<rand>`, uuid rides along as soft `sessionId`).

**Limitation:** without shell integration (OSC 133) there is no reliable idle-at-prompt signal, so we treat "agent gone" as idle — a rare mistype if the user launched a foreground program in that shell. The **fresh-session double-open** gap (a `+Claude` tab carries no `sessionId`, so clicking its sidebar row can't find it) is an accepted gap; the real "already open" signal is the deferred running-indicator work.

## Live-tab surface to the sidebar

`Terminal.onOpenChange` emits `LiveTab[]` (`{id, workspace, kind, sessionId?}`, type in `events.ts`) up through `App` (`liveTabs` signal) into `LeftSidebar`. The sidebar uses it so its confirms count **what is actually running in a folder**, including shell + fresh-agent tabs that `pgrep` never saw:

- **Plain-repo checkout** (`ensureBranch`) appends a non-destructive warning naming the live tab count whose tree is about to change (nothing is killed).
- **Destructive-delete** confirms (space/project + the worktree dialog) count live tabs under the path, **deduped** against `pgrep`-matched resumed sessions by the tab's `sessionId` (`countRunningAgents`). This supersedes counting by `pgrep` alone (see [[gotcha_counting_live_agents_by_tree_nodes_misses_subdir_agents]]). Command tabs used to be excluded here as transient while the purge that follows the confirm killed them anyway, which is [[gotcha_purge_under_path_sweeps_by_cwd_so_a_confirm_that_counts_by_kind_undercounts_it]]; they are counted by cwd now, through `tabUnderFolder`.

## Connections

- Groups the [[concept_shell_hosted_tabs]] hosted by [[component_pty_host]].
- Anchors on the branch-unit `folderPath` of [[concept_folder_anchored_sessions]].
- Rendered through [[component_overflow_tab_bar]] (its `items` are one group's tabs).
- [[adr_jobs_leave_the_tab_model]] carved `kind: "command"` out of this grouping, and its 2026-09-06 amendment put it back under `shells:`; see [[component_shells]] for the surface.

## Only the workspace on screen is active

Every terminal stays mounted, so "which surface is active" is a separate
question from "which is rendered". Until phase 3 of the switching-performance
work, `visibleInPane` never consulted `activeWorkspace()`, so **one terminal per
pane in every visited worktree stayed active**: each switch paid an N-fold fit,
`pty_resize` and `focus()`, and `chat_set_visible(false)` was unreachable.

- `visibleInPane` now answers false for any tab of a background workspace, so
  exactly one surface per visible pane is active however many worktrees were
  visited. Runtime census: 24 terminal hosts across 6 worktrees, **1 visible**.
- `Terminal.tsx` wraps each stage's `active` in a **per-tab `createMemo`**, so
  the fit/focus effects and the `chat_set_visible` flip fire on real edges only.
  A Solid getter prop re-runs its trackers on every notification, value change
  or not, and `on(..., defer)` never deduped values, which is why `false` was
  unreachable while a tab stayed its pane's pick. See
  [[lesson_a_solid_effect_inherits_the_change_rate_of_what_it_reads]].
- The derivation layer is memoized under App's root:
  `installUnifiedTabsMemo` (one union memo), `installPaneTabsMemo` (per visited
  workspace, holding `byPane` and `hostedByPane` built in one O(tabs) pass),
  and a WeakMap cache for `leaves()` (sound because `mapNode` rebuilds every
  changed path).

**`unifiedTabs()` and `paneTabs()` now return the same array object between
changes, so nothing may sort or splice them in place.** All consumers were
checked; `OverflowTabBar` and the strips copy first.

The per-workspace placement memos are never evicted, so a deleted worktree's
memo keeps recomputing until app close. Accepted, bounded by visited worktrees
per run, and it is one of four such caches this ticket added.

## Related

- [[concept_webgl_context_lru]] - the reveal edge this scoping created is where WebGL now attaches
- [[component_perf_trace_harness]] - where the visible-host census is recorded
- [[adr_no_sync_ipc_commands]] - the backend half of the same switch cost
- [[concept_feature_workspace]] - the two-homes rule: tabs opened inside a Feature group under `feature:<id>`, not under the worktree folder
