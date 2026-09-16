---
summary: git status takes index.lock opportunistically, so a concurrent write fails unless it passes no-optional-locks
status: current
updated: 2026-08-20
source: plan "Worktree and tab switching at native speed" (phase 2, personal/sway, branch `unified-tab-bar`), `src-tauri/src/git.rs` (`git_status_body`), `src-tauri/src/exec.rs`, commit d8714d0, [[lesson_the_ipc_thread_was_also_the_lock]], _2026-08-20_
---

# `git status` takes the index lock opportunistically

Do NOT run a git *read* concurrently with a git write and assume the read is harmless. Why: `git status` takes `index.lock` opportunistically so it can write back its refresh, and a concurrent `git add`/`commit` **fails** on that lock rather than waiting for it. Reads can only run outside the per-repo write lock with `--no-optional-locks`, which `git_status_body` now passes. The exec stress test (concurrent `git_stage` + `git_status` + `git_commit` on one repo) is what caught it; `git diff` rode five clean stress runs without the flag, so a passing suite is not evidence the next read is safe.
