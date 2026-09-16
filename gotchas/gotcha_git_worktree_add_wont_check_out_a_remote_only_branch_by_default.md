---
summary: git worktree add fails on a branch existing only as a remote ref, create the local branch with the remote ref as start
status: current
updated: 2026-07-11
source: Attach worktree (personal/sway, branch code-mirror-6); `src-tauri/src/worktree.rs` (`new_branch_start_point`, `remote_branch_exists`, `create_worktree`)
---

# git worktree add won't check out a remote-only branch by default

`git worktree add <path> <name>` where `<name>` exists **only** as `origin/<name>` (no local branch) fails unless `worktree.guessRemote` (or `--guess-remote`) is set, which Sway does not rely on. To attach a remote branch as a worktree you must create the local branch explicitly and give the remote ref as the start point: `git worktree add -b <name> <path> origin/<name>` (which also sets up tracking via the default `branch.autoSetupMerge`). This is why `create_worktree` resolves an `origin/<name>` start point (`new_branch_start_point` → `remote_branch_exists`) instead of passing a bare name, so both *New worktree…* (a typed name that matches a remote) and *Attach worktree…* (a picked remote branch) get a tracking worktree rather than an error or a wrongly-based branch. Feeds [[component_worktree_lifecycle]].
