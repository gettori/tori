---
summary: a git probe cached on dir mtime alone misses a branch switch, key on dir mtime and HEAD, fall to bare HEAD in worktrees
status: current
updated: 2026-06-30
source: Worktree-aware tree (personal/tori, branch code-mirror-6); `src-tauri/src/config.rs` (`cached_probe`, `head_mtime`); commit 5c5177f
---

# mtime cache must key on dir mtime AND HEAD

When caching a per-project git probe, keying on the project **dir mtime alone misses a branch switch** (a `git checkout` doesn't touch the dir's mtime), so `isCurrent`/branch info goes stale. Key on `(dir mtime, HEAD mtime)`. Subtlety: a **worktree container's `.git` is a file** (`gitdir: ./.bare`), so `<dir>/.git/HEAD` does not exist, fall back to `<dir>/.bare/HEAD`. Tori's `head_mtime` tries `.git/HEAD` then `.bare/HEAD`.
