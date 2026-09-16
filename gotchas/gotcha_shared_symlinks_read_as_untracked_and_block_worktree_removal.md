---
summary: symlinked .shared files read as untracked git entries and block worktree removal unless the dirty check ignores them
status: current
updated: 2026-07-10
source: Sidebar as Project Manager + Shared tab (personal/sway, branch code-mirror-6); `src-tauri/src/worktree.rs` (`tree_dirty`, `remove_worktree`, `SHARED_DIR`); commits 09ad986, _shared-tab_
---

# .shared symlinks read as untracked and block worktree removal

Symlinking shared `<container>/.shared/` files into a new worktree makes each one show as an **untracked** entry (`?? .env`). So a naive `git status --porcelain` dirty check AND `git worktree remove` (non-force) both refuse a freshly linked worktree with "contains modified or untracked files", i.e. any worktree that ever used `.shared/` becomes unremovable. Fix: a `.shared`-aware `tree_dirty` that ignores untracked symlinks whose canonical target is inside the sibling `.shared/` (they are regenerable pointers, not user work), and only then `git worktree remove --force` (to drop those symlinks) once the check confirms no real dirt. Verified empirically before fixing. (The convention dir was renamed `.link/` → `.shared/` when it became editable, see [[component_worktree_lifecycle]].)
