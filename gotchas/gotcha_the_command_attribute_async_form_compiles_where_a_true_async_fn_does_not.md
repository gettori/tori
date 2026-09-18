---
summary: a true async fn Tauri command with State and non-Result return is rejected by the macro, unlike the async attribute
status: current
updated: 2026-08-20
source: plan "Worktree and tab switching at native speed" (phase 2, personal/tori, branch `unified-tab-bar`), `src-tauri/src/exec.rs`, commit d8714d0, [[concept_command_execution_tiers]], _2026-08-20_
---

# The command attribute async form compiles where a true async fn does not

Do NOT reach for a true `async fn` when converting a Tauri command that takes `State<'_>` and returns a non-`Result`. Why: the macro rejects it (`AsyncCommandMustReturnResult`, plus E0597 on `__tauri_message__`, tauri issue #2533), while `#[tauri::command(async)]` on the **sync** fn compiles fine and runs the body inside `async_runtime::spawn`. The two forms also differ in where they run: the attribute form blocks a tokio worker, so the hot path wants an `async fn` plus an explicit `spawn_blocking` body instead. Probed against tauri-macros 2.6.3 from source, not assumed.
