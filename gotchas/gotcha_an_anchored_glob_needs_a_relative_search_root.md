---
summary: ripgrep's anchored glob flag matches nothing against an absolute search root, run from a relative current_dir instead
status: current
updated: 2026-08-01
source: "Search panel v2 (branch `wave-1-2`); Phase 1; `src-tauri/src/search.rs:345`; PR #81"
---

# An anchored `--glob` needs a relative search root

Don't pass ripgrep an absolute search root when using anchored globs: `rg --glob 'src/**' -e pat /abs/project` matches **nothing**, while the identical glob against `.` from inside the project matches. Why: rg matches globs against the candidate path as it appears, so a leading-anchored pattern never lines up with an absolute path. There is no error, only zero results, which reads as "no matches". Run from `current_dir(root)` against `.` and strip the resulting `./` prefix.
