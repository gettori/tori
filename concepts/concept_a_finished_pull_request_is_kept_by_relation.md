---
summary: a merged or closed PR stays on a branch only while git_pr_relation says the branch is its own, by reflog age then ancestry
status: current
updated: 2026-09-27
source: "plan "Show merged and closed PR status on worktree rows" (personal/tori, branch `misc-20260927`); commits 662596f1, 6cfe26b5, 2d139c7e, 4d8a5c5d; `src-tauri/src/git.rs:2733` `pr_relation`, `src/utils/prRelation.ts:40`, `src/utils/forgeChip.ts:123`"
---

# A finished pull request is kept by relation

The poll finds pull requests by branch name, and a name outlives the work behind it: merge `feat`, delete it, cut a new `feat` next month, and the old merged PR still answers for it. So a merged or closed PR is shown on a branch only after local git has said how the branch stands against it, and `unrelated` reads as no PR at all, everywhere at once.

## How it works

- **The poll asks for finished PRs.** GitHub adds a second alias per branch (`states:[MERGED, CLOSED]`, newest created first, no check rollup) beside the open one, and the open one wins. GitLab reads one extra `state=all` page only for branches with no open MR. Both skip PRs whose head is a fork. See [[concept_forge_rate_budget]] and [[gotcha_github_headrefname_matches_forks_branches_too]].
- **`git_pr_relation` places the branch** (`git.rs:2733`). A branch whose first reflog entry is later than the PR's end is `unrelated` whatever its ancestry, because a branch recut from a `main` that merged the PR contains its head. Otherwise the tip against the PR's head sha gives `at`, `ahead(n)`, `behind` or `unrelated`; no reflog or a sha missing locally is `unknown`.
- **One store answers every surface** (`prRelation.ts`). Keyed by folder and branch, stamped on the PR and on sync content, it asks once per change and drops a reply older than the newest ask. The row, the Pull Requests panel and the Changes tab all read it, and it enters `forgeChip` so none of them can disagree. See [[lesson_a_cache_stamped_on_object_identity_thrashes_across_two_stores]].
- **The base branch never takes a finished PR.** A `main -> release` PR is not `main`'s.
- **What each answer drives.** Merged with `at` or `behind`: no push mark, no Open PR, the row styled done (`finishedLook`, teal `done.*` roles). Merged `ahead(n)`: a warn mark "n commits after merge" and the normal row. Closed: a dimmed row, and Reopen PR in the Changes tab, which pushes a deleted branch back only when the relation is `at` and the head is not a fork.

## Why it is this way

The forge decides "merged", not local ancestry, because a squash merge leaves nothing an ancestry check can find. Ancestry alone also misreads a branch recut after a merge commit, which is why reflog age comes first. The reflog's first entry is its first recorded update, not a creation stamp, so after reflog expiry an old worktree with post-merge commits can read `unrelated`; accepted as rare, since it falls back to the deleted-upstream mark ([[gotcha_a_pruned_upstream_reads_as_never_pushed]]).

## Related

- [[component_pull_requests_panel]] - loads a finished PR and agrees with the row through `forgeChip`
- [[component_changes_panel]] - Open PR hidden for a merged branch, Reopen PR for a closed one
- [[gotcha_a_translucent_role_cannot_be_a_contrast_surface]] - how the done wash stays measurable
