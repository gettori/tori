---
summary: git rev-parse abbrev-ref HEAD reports the string HEAD before the first commit, use git symbolic-ref short HEAD instead
status: current
updated: 2026-07-01
source: Sidebar as Project Manager (personal/tori, branch code-mirror-6); `src-tauri/src/git.rs` (`do_init` + tests); commit e6f929f
---

# rev-parse --abbrev-ref HEAD returns "HEAD" on an unborn branch

After `git init` (optionally with an initial branch set via `symbolic-ref HEAD refs/heads/<b>`, more portable than `git init -b`), there are no commits yet, so `git rev-parse --abbrev-ref HEAD` reports the literal `"HEAD"`, not the branch name. To read the configured initial branch **before the first commit**, use `git symbolic-ref --short HEAD` instead. Matters for confirming the branch in tests and for any pre-commit branch display.
