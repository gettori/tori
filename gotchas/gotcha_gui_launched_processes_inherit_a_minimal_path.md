---
summary: a macOS gui launched process gets a minimal PATH lacking local bin, homebrew and volta, spawning claude or node fails
status: current
updated: 2026-11-06
source: Tori build plan; `src-tauri/src/env.rs` (`augmented_path`, `LoginPathCache` at `env.rs:138`); `src-tauri/src/chat/transport.rs:91` (`spawn_error`); commits 3c2cde1, 15d039e, f05e68b8
---

# GUI-launched processes inherit a minimal PATH

Do NOT rely on the ambient PATH when spawning any subprocess from the app (`claude`, `node` for the LSP, `code`, `ghostty`); set it explicitly. Why: a macOS GUI-launched (or `pnpm tauri dev`-launched) process gets a minimal PATH that lacks `~/.local/bin` (where `claude` lives), Homebrew, and volta (where `node` lives), so the spawn fails with "not found". Use the shared `env::augmented_path()` (factored out of `pty.rs`/`launch.rs`, also used by `lsp.rs`).

The real PATH comes from a login shell probe (`zsh -lic`, 5 s timeout), and the probe can fail: the first login shell after a macOS update is often slower than that. Do NOT cache that failure. `LoginPathCache` keeps a success for the life of the process and a failure, with its reason, for 30 s (`RETRY_AFTER`), and holds its mutex across the probe so a second caller waits instead of starting a second shell. Agent spawns go through `session_path()`, which blocks on `login_path()`, so a session restored at launch waits for the startup probe rather than spawning on the fallback; PTY tabs keep the non-blocking read. When a spawn still fails, `spawn_error` says whether the folder is gone or the program is not on the PATH it tried, with the probe's failure reason. See [[lesson_a_restart_mid_rebase_lost_a_users_work]].
