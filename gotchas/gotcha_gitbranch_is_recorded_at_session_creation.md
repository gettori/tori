---
summary: a session stores the gitBranch it was created on, not the current branch, one started before git init logs under HEAD
status: current
updated: 2026-06-28
source: Sway build plan (personal/sway); `src-tauri/src/sessions.rs`; commit e121aeb
---

# gitBranch is recorded at session creation

Do NOT assume a session appears under a project's current branch; sessions store the `gitBranch` they were created on. Why: a session started before `git init` (or in a detached state) is logged under `HEAD` and will never match a live branch like `main`, so it shows nowhere until an "unmatched/HEAD" bucket is added.
