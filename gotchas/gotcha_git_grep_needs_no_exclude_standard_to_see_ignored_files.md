---
summary: git grep untracked still honours gitignore by default, the opt out is the separate no exclude standard flag
status: current
updated: 2026-08-01
source: "Search panel v2 (branch `wave-1-2`); Phase 1; `src-tauri/src/search.rs:383`; PR #81"
---

# `git grep` needs `--no-exclude-standard` to see ignored files

Don't reach gitignored files by omitting `--exclude-standard`: that changes nothing, because `git grep --untracked` honours `.gitignore` by default. Why: the opt-out is its own flag, `--no-exclude-standard`; the absence of an opt-in is not an opt-out. Verified on git 2.50.1, where all three of "with", "without" and "no-" produce two distinct behaviours, not three.
