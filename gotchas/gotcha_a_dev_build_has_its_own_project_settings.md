---
summary: a dev build reads ~/.config/tori-dev/settings.json, so a setup command set in the installed Tori is missing there
status: current
updated: 2026-10-21
source: "Browser: open in the browser when the server starts, gettori/tickets#90 (branch `browser-extension`); `src-tauri/src/setup.rs` (`settings_and_logs`), `src-tauri/src/run.rs` (`start_after_setup`)"
---

# A dev build has its own project settings

Before reading a dev build's run or setup behaviour as a bug, check the project's prefs in `~/.config/tori-dev/settings.json`, not `~/.config/tori/`. Why: a debug build keeps its whole config dir apart, so a project whose installed Tori has `setupCommand: "vp install"` can have an empty one in the dev build. With **Start the run command when a worktree is created** on, the run then starts at once against a tree nothing installed, and the run log opens with an unresolved import. It looked exactly like `start_after_setup` not waiting; `~/.config/tori-dev/setup/` held a run log and no setup log.

Related: [[gotcha_the_debug_cli_reaches_tori_dev_not_the_installed_app]], [[component_run_command]].
