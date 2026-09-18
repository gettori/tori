---
summary: transient commands like clone or sign in run as tabs in a synthetic Shells workspace keyed to nobody's branch unit
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Tori's own commands as tabs in a Shells workspace\" (personal/tori, branch `standalone-terminals`, issue #166), Phases 1 to 5; commits `aadacd3`, `30f1ea9`, `cce6db6`, `dd5c029`, `d4a59d3`, then the `+` and the selected row in `0bbbdcc`. Replaces the Jobs module (`src/panels/Jobs/`), deleted in `d4a59d3`."
---

# Shells

**Location:** `src/layout/shellsWorkspace.ts`, `src/utils/features.ts:114`, `src/panels/Terminal/Terminal.tsx:1045`, `src/panels/Terminal/commandStatus.ts`, `src/panels/LeftSidebar/LeftSidebar.tsx:278`

Runs the transient commands Tori starts on the user's behalf: a clone, a bare-worktree bootstrap, an agent install/update/uninstall, a sign-in. Each one is a `kind: "command"` **tab** again, opened in **Shells**, a synthetic workspace keyed `shells:` that is nobody's branch unit. This is not a reversal of [[adr_jobs_leave_the_tab_model]] but its second implementation: the rule was never "these must leave the tab model", it was "these must not be keyed by a branch unit they do not have", and a synthetic key satisfies that exactly as `feature:<id>` already did.

## Responsibilities

- Owns the key and its selection: `SHELLS_KEY`, `isShellsKey`, and a `kind: "shells"` Selection with `folderPath: ""`, so `selectionRoot()` answers null and every root-taking path no-ops rather than branching.
- Seeds the workspace once at startup: one pane, so a command opened from another workspace has somewhere to land before anything selects Shells. The pane carries no kind lock, because it holds two kinds and a lock names one.
- Offers a `+` in its own tab strip, the only control that strip keeps here, opening a plain `kind: "shell"` tab at the user's home folder. There is no branch behind this workspace, so home is the only cwd it can mean.
- Opens each command on `OPEN_JOB`, deduped by id (a second start under a live id reveals the one in progress rather than racing two package managers over one global bin directory), carrying `env`, `rediscoverOnExit` and `recheckAgentsOnExit`.
- Decides whether the window moves: `interactive` true emits `REVEAL_SHELLS` and focuses the tab; false opens without focus, so `activeWorkspace` never leaves the branch the user is working in.
- Tracks each command's verdict in `commandStatus`, a signal keyed by tab id holding `running | ok | failed`, first report wins.
- Auto-closes a command that reported 0, always; keeps a failed or interrupted one on screen with its output and its code. Toasts either way, and a failure's toast reveals the tab.
- Hands the window back: an auto-close that empties the group re-selects the branch unit the most recent command was started from, via `TERMINAL_TAB_FOCUSED`, and stays put if that folder is gone.
- Confirms before closing a **running** command tab, and only a running one. The confirm hangs off `commandStatus`, not off the tab, so a command that already reported closes with no question.
- Suppresses the branch-unit chrome while Shells is selected: the launch cluster, session history, the editor column, the file tree, the right panel and both Toolbar hand-offs.
- **Does NOT** persist a command across a reload. `tabPersist` excludes `kind: "command"` exactly as it excludes `task`, because re-running a clone on relaunch would be destructive. A shell the user opened here does persist, like every other shell tab.
- **Does NOT** hold `kind: "task"` tabs. A task's cwd genuinely is a branch unit, so it stays with it.
- **Does NOT** split. The workspace is one pane by construction, which is also why dropping the kind lock cost nothing: there is no second pane to refuse a drag to.

## Key files & entry points

- `src/utils/features.ts:114` - `SHELLS_KEY = "shells:"`, `isShellsKey`, `shellsSelection()`. `workspaceKey()` and `selectionRoot()` are three-way now. `tabUnderFolder` (`:228`) answers for a `shells:` tab by its **cwd**, exactly as it does for `feature:`, which is what lets a space-delete confirm count a clone running into it.
- `src/layout/shellsWorkspace.ts:15` - `ensureShellsWorkspace()`. It **clears** the pane lock rather than merely not setting one: an install that ran before the `+` has the old `command` lock persisted. The pane is read back off the seeded tree (`shellsPane()`, `:11`), never restated as a literal id, per [[gotcha_a_pane_lock_is_compared_against_the_tab_kind_exactly]].
- `src/panels/Terminal/Terminal.tsx:1045` - `openCommand`, the `OPEN_JOB` consumer. Then `revealShells` (`:1082`), `noteCommandExit` (`:1095`), `autoCloseCommand` (`:1115`), and `lastCommandOrigin` (`:1033`), one remembered branch key rather than a field read off the closing tab: it is the group that empties, not a tab that closes.
- `src/panels/Terminal/commandStatus.ts:16` - `reportCommandExit` returns false on a repeat, which is what makes the toast fire once and a replayed report a no-op. Never a field on `OpenTerm`, per [[gotcha_a_for_over_items_that_record_their_own_state_remounts_them_on_every_update]].
- `src/panels/LeftSidebar/LeftSidebar.tsx:278` - `MODE_VALUES` is the segment order, the persisted-value whitelist and the toggle's step in one. `switchMode` (`:530`) selects Shells; `leaveShells` (`:995`) drops back to Spaces when the terminal points at a folder again. The list is keyed on the **workspace**, not on `kind === "command"`, so a shell the user opened appears in it, and only a command wears a status.
- The list's rows are buttons that emit `FOCUS_SESSION_TAB`, and the one on screen carries `aria-current` plus the brand bar a selected branch row uses. `LiveTab.active` feeds that, filled from `visibleId()`. They render through `<Index>`, not `<For>`: see [[gotcha_a_referentially_keyed_for_over_recomputed_groups_resets_its_children]].
- `src/utils/events.ts:120` - `REVEAL_SHELLS`, for a panel that cannot reach `onSelect`. `OPEN_JOB` (`:425`) kept its name and its payload; only its consumer moved, which is why `Settings.tsx`'s close-on-open listener needed no change.
- `src-tauri/src/runner.rs` - the exit signal. See [[adr_command_exit_by_runner_osc]].

## Connections

- Depends on [[component_pty_host]] for the PTY, the runner file and the once-only `init` delivery.
- Governed by [[adr_jobs_leave_the_tab_model]] - the rule, of which this is the second implementation.
- Governed by [[adr_command_exit_by_runner_osc]] - how a command's verdict arrives once its shell outlives it.
- Fed by `AgentDetail.tsx`, `AgentAccounts.tsx` and `LeftSidebar.tsx` through `OPEN_JOB`; `install.ts` (`setupJob`) and `signIn.ts` (`loginJob`) build the payload.

## Related

- [[concept_workspace_tab_grouping]] - the model these commands rejoined, under a key that is not a folder.
- [[concept_feature_workspace]] - the other synthetic key, and the pattern `shells:` copies.
- [[concept_shell_hosted_tabs]] - every terminal tab is a login shell, command tabs included now.
- [[gotcha_purge_under_path_sweeps_by_cwd_so_a_confirm_that_counts_by_kind_undercounts_it]] - the asymmetry the space-delete confirm carried.
- [[gotcha_a_command_tab_is_born_live_so_it_spawns_whether_or_not_you_are_looking_at_it]] - why a background clone still runs.
- [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]] - why a running one confirms before it closes.
