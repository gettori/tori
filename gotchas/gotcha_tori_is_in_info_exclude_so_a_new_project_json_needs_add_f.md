---
summary: Tori writes .tori to .git/info/exclude, so a new .tori/project.json stays out of git status until git add -f
status: current
updated: 2026-10-28
source: plan "Shareable project config in the repository, trust-gated" (branch shareable-project-config, gettori/tickets#49); commits ef60287f, d944ce30, e8de60e9, 70a3fb0c; src-tauri/src/git.rs (exclude_from_repo), callers in workspace_settings.rs, topics.rs, worktree.rs
---

# A new .tori/project.json is invisible to git

In a repo Tori has already worked in (a workspace settings save, a Topic worktree, a plain repo worktree), `exclude_from_repo(root, ".tori")` put the whole `.tori` directory in `.git/info/exclude`. A user who then creates `.tori/project.json` to share sees nothing in git status and may think the file is not there. `git add -f .tori/project.json` once is enough, and git tracks it from then on. Narrowing the exclude to Tori's own subpaths was considered and left: documenting the one command was the smaller change.

## Related

- [[concept_repo_proposals]]
