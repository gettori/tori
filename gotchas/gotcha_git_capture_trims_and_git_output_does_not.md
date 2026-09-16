---
summary: git_capture trims its result, reading a blob through it shaves leading indentation and a trailing newline off a restore
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 15 (personal/sway, branch `wave-6`); `src-tauri/src/checkpoint.rs:378`, `src-tauri/src/local_history.rs:238`; commit b622f33"
---

# `git_capture` trims and `git_output` does not

Do NOT move file bytes through `git_capture`. It trims its result (`checkpoint.rs:378`), so reading a stored blob with it shaves the leading indentation off the first line and the trailing newline off the last, and a restore hands the file a version of itself it never had. `git_output` (`:393`) is the untrimmed variant and its doc comment says exactly why it exists. Why: the trimming one is the convenient default and is correct for every `rev-parse`-shaped answer, which is what makes the wrong choice look right.
