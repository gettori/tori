---
summary: pgrep -af means include ancestors on BSD and macOS, not full command lines, use -lf or every session reports dead
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown (branch `navigation`, phase 2); `src-tauri/src/sessions.rs`; commit a713a26
---

# The pgrep flag for full command lines differs on macOS

Do not use `pgrep -af` to get full command lines on BSD/macOS. There `-a` means "include process ancestors" and prints bare pids; `-lf` is what prints the argument list. Why: `-af` exits 0 with plausible-looking output, so a matcher built on it finds nothing and reports every session dead.
