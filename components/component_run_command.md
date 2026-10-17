---
summary: run.rs starts a project's run command headless, stops it with TERM then KILL, and reaps crash leftovers from runs.json
status: current
updated: 2026-10-18
source: plan "Run and teardown commands beside the setup command" on branch phase-1-block-4, ticket gettori/tickets#41; src-tauri/src/run.rs, src-tauri/src/setup.rs:360, src/utils/runStore.ts
---

# Run command

`src-tauri/src/run.rs` starts and stops a project's run command, a dev server usually, in one worktree at a time. It is a thin layer on setup's `Runs` core with `Kind::Run` ([[component_worktree_setup]]), headless rather than a tab ([[adr_run_command_headless_not_a_tab]]).

## Responsibility

- **Start** (`start`, `run.rs:79`): reads `runCommand` from the project's `WorktreePrefs`, refuses an empty one, and refuses unless `worktree::not_a_fork` is true, so a worktree git cannot read counts as a fork. It waits out a run still `Stopping` before taking its start lock, answers the live report when one is `Running`, and refuses "The last run is still stopping." if the old one outlasts the wait. No time limit.
- **Stop** (`Runs::stop_where`, `setup.rs:360`): marks the entries `Stopping`, sends TERM to each group, waits once for the shared 5 s grace, then KILLs what is left. `finish` turns a `Stopping` entry into `Stopped` whatever the exit code, so a stop never reads as `Failed`. `stop_all` runs on `RunEvent::Exit`, and `do_remove_worktree` stops the run before teardown.
- **The record** is `<config dir>/runs.json`, a list of `{ pgid, worktree }`. It is written after a start and cleared by the run's publisher on any state that is not live. At launch `reap` lists each group with `pgrep -g` and stops it only if a member's cwd (from `lsof -d cwd`) is under the recorded worktree (`still_ours`, `run.rs:155`), because a pgid can be reused. It then deletes the file.
- **Logs** share `<config dir>/setup/` as `<folder>-run-<nanos>.log`. Past 5 MB a log is cut back to its last 1 MB while the run writes ([[gotcha_cutting_a_log_a_child_writes_needs_append_mode]]), and launch deletes run logs older than 7 days.
- **Does NOT** restart a run, auto-start one on open, or keep one across an app restart.

## Interface

- Tauri: `run_start(projectPath, worktreePath)`, `run_stop(worktreePath)`, `run_list()`, and `worktree_not_a_fork(worktreePath)` in worktree.rs.
- Events: `setup://changed` with `kind: "run"` and states `running`, `stopping`, `stopped`, `done`, `failed`.
- `src/utils/runStore.ts`: `runAt(worktree)`, seeded by `run_list` after the listener is up, plus `runnable(worktree)`, false until Rust answers. `runProjectFor(worktree)` in settingsStore picks the deepest project holding the worktree that has a run command.
- Surfaces: the play/stop button in the sidebar row's end cluster, "Start the run command" and "Stop the run command" in the palette (requirement tags `runCommand`, `runIdle`, `runLive`, resolved on `frontWorktree()`), and a "Run command" row at the top of Scripts. A run that exits on its own with a failure toasts with Show log.

## Related

- [[component_worktree_setup]]: the shared core and the removal order
- [[adr_run_command_headless_not_a_tab]]: why not a terminal tab
- [[component_worktree_cleanup]]: the sweep refuses a worktree with a live run
- [[component_ports]]: why the port chips rescan on run events
