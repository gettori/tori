---
summary: fs_read_dir shells out to git check-ignore per call for gitignored entries, a keystroke driven listing spawns processes
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 14 (personal/sway, branch `wave-6`); `src-tauri/src/fs.rs`, `src/components/Omnibox/Omnibox.tsx`; commit 44d8c99"
---

# `fs_read_dir` shells out to `git check-ignore`

Do NOT call `fs_read_dir` on a path anyone's keystroke is waiting for. It resolves gitignored entries through `gitignored_paths`, which runs `git check-ignore --stdin` as a subprocess, so an eager listing on a hot path buys a process spawn per open. Loading the task list in the omnibox's `onMount` made every ⌘P pay for one, for rows the file picker never shows. Why: it reads like an ordinary directory listing at the call site.
