---
summary: osascript choose folder is a zero dependency native macOS folder picker, no Tauri dialog plugin required
status: current
updated: 2026-06-30
source: Worktree-aware tree (personal/tori, branch code-mirror-6); `src-tauri/src/config.rs` (`pick_folder`); commit 3501d59
---

# Native folder picker via osascript

For a native macOS folder picker, `osascript -e 'POSIX path of (choose folder …)'` is a zero-dependency alternative to the Tauri dialog plugin (which needs a Cargo dep, an npm package, plugin registration, and a capability entry). Cancel exits non-zero → return `None`. Fits a macOS-only app that already shells out (git/pgrep) and avoids a network install mid-build.
