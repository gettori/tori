---
summary: a project's setup command runs headless per new worktree in Rust, not a tab, since worktree.new must answer its status
status: current
updated: 2026-10-10
source: plan "Run a setup command when a worktree is created" on branch setup-command, ticket gettori/tickets#2; src-tauri/src/setup.rs, src-tauri/src/worktree.rs:351, src-tauri/src/rpc/methods.rs:459
---

# Worktree setup

`src-tauri/src/setup.rs` runs a project's setup command (an install, usually) in each worktree Tori creates for it, and keeps how that went.

## Responsibility

- **Where the command comes from.** `settings.json` holds a `worktree` map keyed by project path, each entry `{ setupCommand, setupWait }` (`WorktreePrefs`). An empty command runs nothing, and that is the default. The project key is matched with `same_folder`. The Worktrees section of the project settings dialog ([[component_project_settings_dialog]]) edits it for a bare container. A plain repo has no page, but a hand edited entry still runs.
- **Who runs it.** `create_worktree_in` on a real creation, never on reuse ([[component_worktree_lifecycle]]). That covers the sidebar, `worktree.new`, `session.spawn` with `new_worktree` and Topic members. Attempts run it after their dependency clone, so the command only reconciles. A PR worktree runs it only when its head is on origin (`PullRequest.head_repo_is_origin`). The command is the user's, but a fork's tree is a stranger's, and auto pickup would run its install scripts with nobody watching.
- **How it runs.** `sh -c` with cwd at the worktree, stdin closed, the login PATH, `TORI_PROJECT_ROOT` (the project path, which for a container is the folder holding the worktrees and has no checkout) and `TORI_WORKTREE_PATH`. Output goes to `<config dir>/setup/<folder>-<nanos>.log`. It spawns in its own process group, so the kill at `LIMIT` (30 minutes) and the kill on removal take its children too.
- **What it keeps.** `Runs`, an in memory list of `Report { worktree, state: running|done|failed, code, log }`, one per folder, read through canonical paths and `same_folder` ([[gotcha_git_worktree_list_reports_canonical_paths]]). After a restart every folder reads none. Each change is published as `setup://changed`, and the webview toasts a finish or a failure with Show log (`src/utils/setupToasts.ts`).
- **Does NOT** refuse anything. A failed setup is reported, and a spawn into that folder still goes ahead.
- **Does NOT** use a command tab. A command tab's exit is known only to the webview ([[component_shells]]), and `worktree.new` has to answer with the verdict. Five autopilot worktrees would also open five tabs.

## Interface

- `on_created(project, worktree)`: the thin layer. It reads the setting, picks the PATH and the publisher, and starts a run.
- `status(worktree)`, `wait(worktree, cap)`, `kill(worktree)`. `do_remove_worktree` calls `kill` before `git worktree remove`, so an install is not writing into a folder git is deleting.
- `configured(project)`: the project's prefs when it has a command.
- `Runs::start(Spec, Publish)`: the core. It takes the command, paths, limit and publisher as arguments, so its tests need no app and no settings file ([[lesson_pure_core_for_global_stores]]).
- `seam(prefs, log_dir)`, test only: a thread-local stand in for the settings file and the log folder. Without it, a test of a creation path would read the developer's real `settings.json`, because `config_dir()` cannot be redirected.
- Socket: `worktree.new` answers `setup: none|skipped|running|done|failed` and `setup_log` (`setup_fields` in `rpc/methods.rs`). With `setupWait`, `worktree.new` and `session.spawn` wait up to `WAIT_CAP`, 240 s, under the 300 s at which codex-acp kills a tool call ([[concept_blocking_tool_call_ceiling]]). Past the cap the answer is `running`, and asking again waits again. The CLI prints the state on stderr so stdout stays the path.
- The autopilot brief's "A new worktree's setup" section says what a worker is told for `running`, `failed` and `skipped` ([[component_autopilot_runner]]).

## Related

- [[component_worktree_lifecycle]]: the creation core that starts a run and the removal that kills one
- [[component_shells]]: the command tab this deliberately is not
- [[concept_blocking_tool_call_ceiling]]: where the 240 s cap comes from
- [[lesson_pure_core_for_global_stores]]: why the core takes its settings as arguments
