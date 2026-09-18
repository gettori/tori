---
summary: the PR list, diff, threads and merge bar read checks from the shared poll store rather than fetching their own copy
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phases 4, 6, 8 to 13; commits 85728ec, db4be3b, cdd19dc, ce1c941, 51f1f1a, 8e6f03b, d0d9a3e, 945c1bd"
---

# Pull Requests panel

**Location:** `src/panels/Editor/PullRequests/` (key files: `PullRequests.tsx`, `PrDetail.tsx`, `ReviewBar.tsx`, `ReviewThreadView.tsx`, `MergeBar.tsx`), plus `src/components/ForgeChip/` and the pure cores in `src/utils/forge*.ts`

The in-app surface for a project's pull requests: the list, one PR's files and threads, the review being written, and landing it. It is a [[concept_synthetic_editor_tabs]] view, so it opens as an editor tab and carries its workspace. Every decision it makes lives in a pure module beside it; the components hold signals, effects and markup.

## Responsibilities

- Lists a project's pull requests and opens one, reading checks from the poll store rather than fetching its own copy.
- Renders a PR's changed files, expandable from the local object store ([[concept_pr_diff_two_sources]]).
- Reads review threads, replies to them, resolves them, and places each card next to the line it is about.
- Holds a pending review and submits it in one call ([[concept_review_line_anchoring]]).
- Hands a thread to the agent that wrote the branch, through the one send path ([[concept_safe_send]]).
- Lands the pull request, and asks the sidebar to delete the branch ([[concept_mergeability_is_asked]]).
- Does **not** own polling, the rate budget, or the credential. It reads `forgeStatus.ts` and invokes commands.
- Does **not** own branch deletion. It emits `REMOVE_BRANCH_UNIT` and the sidebar's dialogs (with their dirty, unpushed and running-agent guards) decide what happens.

## Key files & entry points

- `PullRequests.tsx` - the list, and the re-read after a PR lands
- `PrDetail.tsx` - files, threads, review, merge; owns the effects and the staleness guards
- `ReviewBar.tsx:24` - draws only once something is pending or the reader starts typing, so an unreviewed diff carries no chrome
- `ReviewThreadView.tsx` - one thread card, its reply box, its resolve action and its send-to-agent row
- `MergeBar.tsx:47` - method picker (defaults to squash), the gated merge button, the server's refusal verbatim
- `src/components/ForgeChip/ForgeChip.tsx` - the shared chip, in the sidebar row and the PR list
- `src/utils/forgeChip.ts:54` - five chip kinds, and why only two of them draw
- `src/utils/createPr.ts:37` - `prPath`: one button, three destinations (form, compare URL, nothing)
- `src/utils/pendingReview.ts` / `mergeGate.ts` / `prFiles.ts` / `reviewThreads.ts` / `threadAsk.ts` - the pure cores

## Connections

- Depends on [[component_forge_client]] - every fact on screen comes from a Tauri command
- Depends on [[component_editor_stores]] and [[concept_editor_tab_workspaces]] - it is an editor tab
- Reuses `diffView.ts` and `DiffRows` from [[component_changes_panel]] - one diff renderer, two callers
- Sends through [[concept_safe_send]] - `composeThreadAsk` is its fifth composer
- Routes deletion to [[component_worktree_lifecycle]] via the sidebar
- Governed by [[adr_github_api_layer]]

## Related

- [[concept_forge_rate_budget]] - why the panel reads checks instead of fetching them
- [[lesson_sanitize_text_you_did_not_author]] - the security finding this panel produced
- [[gotcha_diffrows_reads_props_selection_once_per_row]]
- [[gotcha_array_prototype_at_is_outside_this_repos_ts_lib]]
