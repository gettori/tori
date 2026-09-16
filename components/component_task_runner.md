---
summary: tasks come from npm scripts, make targets and just recipes, a rerun always opens a new tab since init only fires once
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface (personal/sway, branch `wave-6`); Phase 14, issue #56, commit 44d8c99"
---

# Task runner (npm scripts, make targets, just recipes)

**Location:** `src/utils/tasks.ts`, `src/utils/taskRecents.ts`, `src/utils/runTask.ts`, `src/panels/Editor/TasksPanel.tsx`

Reads the project's own command list out of its own files and runs one in a login-shell terminal tab. Three surfaces reach it (the omnibox in `>` mode, the Tasks panel, and ⌘⇧B for the last one), and all three go through `runTask`.

## Responsibilities

- **`tasks.ts`** — the pure model and three text-only parsers. `parsePackageScripts` (`:69`), `parseMakeTargets` (`:96`), `parseJustRecipes` (`:122`), plus `packageRunner` (`:47`) and `taskTab` (`:150`). `loadTasks` reads npm, then make, then just.
- **`taskRecents.ts`** — a per-workspace record of what has been run, capped at 10, ordered by recency: the "what you did" side of [[concept_path_keyed_workspace_stores]]'s split.
- **`runTask.ts`** — the one place the three surfaces share. It records the run, *then* opens the tab, because the tab's id carries the run count. `rerunLast(root)` returns a `RerunOutcome` so App can toast the difference between "nothing run here" and "no workspace".
- **`TasksPanel.tsx`** — the `rightMode` strip entry: sections per source, a `scanGen` latest-wins guard, a 400 ms debounce on `fs://changed`, and an error state that says what happened rather than claiming the project defines no tasks.
- **Does NOT** register anything in `EditorDefaults` or `settingsCatalog`. Tasks come from the project's own files, so there is nothing to make a setting of.

## Key files & entry points

- `src/utils/tasks.ts:150` — `taskTab(root, task, run)` mints `task:<root>:<id>#<n>` and titles a re-run `name (2)`.
- `src/utils/runTask.ts` — `runTask` and `rerunLast`.
- `src/utils/commands.ts` — the `rerun-last-task` entry (⌘⇧B), emitting `RUN_LAST_TASK`.
- `src/panels/Terminal/Terminal.tsx` — `TabKind` gained `"task"`; the `OPEN_TERMINAL` handler passes `init` through.
- `src-tauri/src/pty.rs` — two tests pinning that `init` is delivered exactly once however many callers arrive, and that a tab with no `init` is written nothing.

## Design decisions worth keeping

- **`init` is a seam that fires once, so a re-run cannot reuse a tab.** `pty_spawn` delivers `init` backend-once and is idempotent on re-subscribe, which is exactly what makes a remount re-subscribe rather than re-type - and also why a second run needs a second tab, since the shell already took its one command line. The run ordinal therefore lives in the tab id.
- **Kill-and-respawn was considered and rejected.** `closeId` fires `pty_kill` asynchronously while the fresh mount calls `pty_spawn` with the same id, and `pty_spawn` re-subscribes to a session still present in `PtyState`, so the re-run would silently attach to the process being killed. A new tab per run has no such race and keeps the previous run's output to compare against.
- **`task` is its own `TabKind`, not a `shell` carrying an `init`.** `tabPersist` restores shell tabs and does not store `init`, so a task tab would come back on relaunch as a bare shell wearing the task's name. `PersistedKind` already excludes `command` because re-running a clone on relaunch would be destructive; a distinct kind inherits that exclusion. Nothing else branches on it: `pty.rs` branches on `command` alone so `task` gets the login shell, and `LeftSidebar`'s live-work count uses `kind !== "command"` so a running build correctly counts.
- **The package manager comes from the lockfile, not a preference.** `npm run dev` in a pnpm repo is not a setting somebody got wrong, it is a command that installs the wrong tree.
- **Task names are shell-quoted.** They come out of a file in the project and the line is typed into a live shell, so `build; rm -rf ~` has to arrive as one word.
- **Parsers are text-only on purpose.** `npm run`, `make -qp` and `just --list` would each be a subprocess per project open, for a marginally better parse of a list wanted before anyone has decided to run anything. The sharp cases are all colons that are not rules: `CC := gcc`, a recipe body's `echo one: two`, and just's `alias b := build`; each has a test.

## Connections

- Built on [[concept_shell_hosted_tabs]] — the fourth tab kind, and the `init` seam is the whole mechanism.
- Listed by [[concept_omnibox_prefix_router]] — `>` mode's task rows, loaded lazily for the reason recorded there.
- Recents follow [[concept_path_keyed_workspace_stores]]' "what you did" contract.

## Related

- [[gotcha_pty_spawns_init_fires_once_so_a_re_run_needs_a_new_tab_id]] — the trap in one line.
- [[gotcha_a_command_seeded_into_a_shell_is_re_parsed_quote_its_args]] — the pre-existing trap this obeys.
- [[gotcha_fs_read_dir_shells_out_to_git_check_ignore]] — why loading tasks eagerly in the omnibox was a real regression.

## Known gaps

- A rerun started from the hotkey or the omnibox leaves an open Tasks panel's Recent list stale: all three surfaces write through to storage, but the panel holds a signal read at mount. The fix would be a listener on `OPEN_TERMINAL`, an indirect trigger for "recents changed".
- That a `file:line` in a task's output is clickable is **verified by inspection, not by test**: `TerminalView` registers its link provider unconditionally with no reference to `props.kind` and resolves relative tokens against `props.cwd`, which `taskTab` sets to the workspace root. Every test in the repo mocks `TerminalView` away because it needs a real xterm renderer.
