---
summary: ensure_inside resolves symlinks only to decide containment and returns the unresolved path, breaking on macOS's /var
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 1 (personal/sway, branch `wave-6`); `src-tauri/src/fs.rs`; commit 5386ef8; [[concept_one_directory_two_spellings]]"
---

# `ensure_inside` returns the caller's unresolved path

Do NOT assert the canonicalised form of a path that came back from `ensure_inside`. It resolves symlinks only to *decide* containment and hands back what the caller passed, so a test expecting the resolved form fails on macOS, where `/var` is a symlink to `/private/var` and every temp dir is under it. Why: the function's job is a yes/no, and returning the input is what keeps callers from silently rewriting user-visible paths.
