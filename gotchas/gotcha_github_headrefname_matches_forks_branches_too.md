---
summary: GitHub's pullRequests(headRefName:) also returns forks' PRs from a same-named branch, so skip isCrossRepository
status: current
updated: 2026-09-27
source: "plan "Show merged and closed PR status on worktree rows" (personal/tori, branch `misc-20260927`); commits 662596f1, 6cfe26b5, 2d139c7e, 4d8a5c5d; `src-tauri/src/forge/github.rs:780`"
---

# headRefName matches forks' branches too

Do NOT take the first node of `pullRequests(headRefName: "feat")` as this repo's branch's PR: a fork's `feat` opened against this repo matches the same filter. Ask for a few (`first:5`) and take the first with `isCrossRepository: false`; GitLab's equivalent is `source_project_id == target_project_id`. Why: the filter is on the ref name alone, and the fork's PR would put someone else's merged or closed state on your row.

## Related

- [[concept_a_finished_pull_request_is_kept_by_relation]]
