---
summary: a plain repo's secondary worktrees are invisible to Spaces unless appended as their own branch units
status: current
updated: 2026-08-28
source: "Feature lifecycle, member management and repair (personal/tori, branch `feature-workspace`, issue #159) - phase 2 - `src-tauri/src/config.rs` `secondary_worktree_units`, commit ef3779b - _2026-08-28_"
---

# A plain repo does not list its secondary worktrees as branch units

Do NOT assume a worktree is reachable in Spaces just because it is on disk inside a discovered project. Why: `probe_project`'s no-bare branch went to `plain_branch_units` (`config.rs`), which enumerates `git branch` and keeps only the current checkout and `attached.json` entries, and the folder walkers skip `.tori/worktrees` (`fs.rs:521`), so a Feature worktree kept in a plain repo was invisible in Tori entirely. `secondary_worktree_units` now appends one `ProjectKind::Worktree` unit per entry after the main worktree. **Contained ones only**: a linked worktree beside its repo is a project in its own right, so claiming it would put a folder outside this project under it and list the pair twice once the sibling is probed. The containment test runs against git's own path for the main worktree rather than the probed one, so a symlinked space root cannot make it silently match nothing.
