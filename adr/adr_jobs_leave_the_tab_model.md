---
summary: a clone or install cannot be keyed by a branch unit it lacks, so it is a tab in a synthetic shells workspace instead
status: current
updated: 2026-09-03
source: "plan \"Jobs: transient command terminals leave the tab model\", branch `bugfix-260903`, phases 1 and 2. Commits `8f6f68c` (the exit code) and `3a9f882` (the move). Diagnosed from `Terminal.tsx:891`."
---

# Jobs leave the tab model

A transient command Sway runs on your behalf (a clone, a bare-worktree bootstrap, an agent install/update/uninstall, a sign-in) is a **Job**, not a tab: it has no workspace, it lives in `src/panels/Jobs/jobStore.ts`, and it shows up as a tray row above the sidebar's mode tabs plus one bottom drawer over `.workspace`. It leaves [[adr_generic_panes_unified_tabs]]'s unified tab model rather than taking a dock inside it, because the tab model groups on a branch unit and these commands have none: a clone creates the folder, so the folder is not a branch unit until after the command that was supposed to be keyed by it.

Amended: 2026-09-06 (see the Amendment below)

## Amendment, 2026-09-06

**The rule holds. The mechanism changed.** These commands are `kind: "command"` **tabs** again, in a synthetic workspace keyed `shells:` that is nobody's branch unit. That is not a reversal: the decision was never "these must leave the tab model", it was "these must not be keyed by a branch unit they do not have". A synthetic key satisfies that the same way `feature:<id>` already did, and it buys back the tab strip, the pane model and one always-mounted stage instead of a bespoke tray and drawer.

What the synthetic key preserves, restated as the test that pins it: a `shells:` tab never joins a branch unit's strip (`paneTabs` is unchanged while one is open) and never hides one (`activeWorkspace` still equals the unit). `interactive` decides whether the window moves at all, because `focusTab` writes `activeWorkspace` and that write is the original bug.

Source: plan "Standalone terminals: Sway's own commands as tabs in a Shells workspace" (personal/sway, branch `standalone-terminals`, issue #166), Phases 1 to 5 · commits `aadacd3`, `30f1ea9`, `cce6db6`, `dd5c029`, `d4a59d3`. The Jobs module was deleted in `d4a59d3`; see [[component_shells]].

## Considered Options

- **A tab keyed on its own cwd** (what shipped, and the bug): `paneTabs` drops a tab whose workspace is not the sidebar's `wsKey()`, so an install at `homeDir()` or a clone at a space path appeared in no strip at all, while `focusTab` moved `activeWorkspace` to that key and `visibleInPane` hid every real tab of the unit the user was in. The surface still painted, because a pseudo-workspace has no layout envelope and `onScreen` fell back to `visibleId()`. The result was a full-pane terminal with no tab, no close button, and the user's own session behind it.
- **A dock inside the pane model** (rejected): the pane ADR already rejected docks, and a dock would have inherited the workspace keying that caused the bug in the first place.
- **Jobs outside the tab model** (chosen): no workspace, no strip, no pane. Nothing a job does can move what the tab model shows.

## Consequences

- `pty://exit` carries `{ id, code: number | null }` rather than a bare id, so a clean exit can clear its own job and a failure can stay. The code is polled with `try_wait`, never waited for, because `pty_kill` takes the same lock on the IPC thread ([[adr_no_sync_ipc_commands]]). A `null` code is an exit the backend could not confirm within 2s, and it counts as a failure: the output a premature success would close over is exactly the output worth keeping.
- A job's `TerminalView` stays mounted for the job's whole life and portals into its own stage host, so which job is on screen is a question of adoption, never of mounting ([[lesson_a_mount_gate_is_a_destroy_gate]]). The `For` runs over ids rather than over job objects for the same reason: recording an exit replaces the object, and `For` diffs by reference, so iterating the list would rebuild the surface at the moment its output matters most.
- Jobs are not persisted across a reload. `pty_live_ids` already lists the surviving processes, so reattachment is possible; what is missing is a persisted job list, and a job you started deliberately is cheap to restart.
- ~~`kind: "command"` is now unreachable in `TabKind`~~ **superseded 2026-09-06.** The kind is revived with a new meaning, shell-hosted rather than direct-spawn, and `OPEN_JOB` opens it as a tab in `shells:`.
- ~~The tray lives in the sidebar, which can be hidden.~~ **superseded 2026-09-06.** The tray and the drawer are gone; the surfaces are the Shells workspace's own tab strip and a third sidebar mode beside Spaces and Features. The exit toast survives, and a failure's action reveals the tab rather than the drawer.
- `pty://exit` is still the shell's own end, but it is no longer a command's verdict: a command tab's shell outlives its command, so the code arrives on OSC 8791 from a runner script instead. See [[adr_command_exit_by_runner_osc]].

## Related

- [[adr_generic_panes_unified_tabs]] - amended: the transient commands leave the model rather than taking the dock it rejected
- [[adr_no_sync_ipc_commands]] - why the exit status is polled and never waited for
- [[adr_lazy_tab_attachment]] - the other narrowing of "everything stays mounted"
- [[concept_workspace_tab_grouping]] - the cwd keying this removes
- [[component_shells]] - where these commands live now; it replaces the `component_jobs` page, deleted with the module
- [[adr_command_exit_by_runner_osc]] - how a command's verdict arrives, once its shell outlives it
- [[lesson_a_mount_gate_is_a_destroy_gate]] - why the drawer hides and never unmounts
- [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]] - why stopping a running job is destructive
