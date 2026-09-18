---
summary: a macOS gui launched process gets a minimal PATH lacking local bin, homebrew and volta, spawning claude or node fails
status: current
updated: 2026-06-29
source: Tori build plan; `src-tauri/src/env.rs` (`augmented_path`); commits 3c2cde1, 15d039e
---

# GUI-launched processes inherit a minimal PATH

Do NOT rely on the ambient PATH when spawning any subprocess from the app (`claude`, `node` for the LSP, `code`, `ghostty`); set it explicitly. Why: a macOS GUI-launched (or `pnpm tauri dev`-launched) process gets a minimal PATH that lacks `~/.local/bin` (where `claude` lives), Homebrew, and volta (where `node` lives), so the spawn fails with "not found". Use the shared `env::augmented_path()` (factored out of `pty.rs`/`launch.rs`, also used by `lsp.rs`).
