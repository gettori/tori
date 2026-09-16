---
summary: git show's default combined diff is empty for a clean merge, use diff-tree with first parent to get real hunks
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/sway, branch `wave-2`); Phase 7; `src-tauri/src/git.rs` (`git_commit_files`); commit b108974"
---

# `git show`'s default combined diff is empty for a clean merge

Don't render a commit with plain `git show` or `diff-tree` and assume a merge will produce hunks. Why: for a merge commit both default to the *combined* diff, which shows only hunks that differ from **every** parent, and a clean merge has none, so the commits people most want to inspect render as an empty body that reads like a failed load. Use `diff-tree -r -m --first-parent` to get one diff against the branch it landed on. While you are there, `--root` is what gives the very first commit a diff against nothing rather than nothing at all. Probe both against a real repository; neither shape appears in a fixture you wrote yourself.
