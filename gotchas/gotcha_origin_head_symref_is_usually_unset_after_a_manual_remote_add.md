---
summary: origin/HEAD is only written by git clone or an explicit set-head, so a typed remote-add leaves it unset
status: current
updated: 2026-07-19
source: Review-to-prompt + commit flow (personal/sway, branch `topbar`); `src-tauri/src/git.rs` (`git_default_base_branch`); commit 35bc401; see [[component_changes_panel]]
---

# origin/HEAD symref is usually unset after a manual remote-add

Do NOT assume `refs/remotes/origin/HEAD` is set just because `origin` is configured — it's normally only written by `git clone` or an explicit `git remote set-head`. Sway's own `git_remote_add` flow (typed URL, not a clone) never sets it, so PR base-branch derivation has to fall back to probing `refs/remotes/origin/main` then `refs/remotes/origin/master` — and that probe itself needs a prior fetch or push, since remote-tracking refs don't exist until then. In practice the fallback probe, not the symref read, is the path that fires for this app's repos.
