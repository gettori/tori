---
summary: git worktree list prints canonicalized paths, a starts_with containment check needs both sides canonicalized on macOS
status: current
updated: 2026-07-09
source: Sidebar Context-Menu Redesign (personal/sway, branch code-mirror-6); `src-tauri/src/worktree.rs`; commit dac1093; [[concept_one_directory_two_spellings]]
---

# git worktree list reports canonical paths

`git worktree list --porcelain` prints **canonicalized** worktree paths. On macOS `/tmp` is a symlink to `/private/tmp` (and `std::env::temp_dir()` returns the un-resolved form), so a path built from the container dir does **not** string-prefix git's reported path. Any `wt_path.starts_with(container)` "is this worktree inside my container?" guard then silently fails, and the loop that depends on it does nothing (cost a green-looking test that actually relinked zero files). Fix: canonicalize **both** sides before comparing (`std::fs::canonicalize(...).unwrap_or_else(|_| as_is)`), the same defense `config.rs::is_inside` already uses for pin nesting. (The `relink_worktrees_pure` site that first hit this was later removed with the relink surface; the canonical-paths trap itself still applies to any `git worktree list` prefix guard.)
