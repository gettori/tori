---
summary: git log exits non-zero on a repo with an unborn HEAD, the normal state of a fresh worktree, so probe HEAD first
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/sway, branch `wave-2`); Phase 6; `src-tauri/src/git.rs` (`git_log`); commit fecf42d"
---

# `git log` exits non-zero on a repo with no commits

Don't treat a failing `git log` as an error to surface. Why: a repository with an unborn HEAD, which is exactly what a freshly bootstrapped worktree is, makes `git log` exit non-zero, so the natural error path shows a scary message for the most ordinary state a new project can be in. Detect it first with `rev-parse --quiet --verify HEAD`, whose `--quiet` silences that one failure and says nothing on stderr, and return an empty log. Anything with a real complaint attached (not a repository, folder gone) still propagates.
