---
summary: worktree add refuses a branch the main checkout holds even with --no-checkout, make the repo bare first
status: current
updated: 2026-10-11
source: "gettori/tickets#74, convert a plain clone to the bare plus worktree layout (personal/tori, branch phase-1-block-2); measured on git 2.54.0; src-tauri/src/convert.rs forward()"
---

# `git worktree add` refuses a branch the main checkout holds

In a non-bare repo on `main`, `git worktree add --no-checkout <path> main` fails with `fatal: 'main' is already used by worktree at <repo>`, and `--no-checkout` does not help. After `git config core.bare true` the same command succeeds, since a bare repo's HEAD is not a checkout. So a conversion has to make the repo bare before it adds the worktree for the current branch, which is why [[concept_worktree_layout_conversion]] moves the files out first. `--force` would also pass, but it hides the check for every other branch too.
