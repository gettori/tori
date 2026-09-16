---
summary: a review comment anchors by line and side, never GitHub's position, and the whole review submits in one atomic call
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phases 10 and 11; commits 51f1f1a, 8e6f03b; `src/utils/pendingReview.ts:47`, `src/utils/reviewThreads.ts:44`"
---

# Review line anchoring (line and side, never position)

A review comment has to say which line of which file it is about, and a diff offers two numberings that stop agreeing above the first change. Sway anchors every comment by **line plus side**, holds the whole review locally, and submits it in one call. All three parts are forced by the API rather than chosen for convenience.

## How it works

- **Side decides the numbering.** `rowSide` (`pendingReview.ts:25`) counts a removal in the base file (`LEFT`) and everything else in the head file (`RIGHT`). Line 12 of the base is not line 12 of the head, so `line` alone is ambiguous: a comment on a removed line sent in head numbering lands on its replacement.
- **`position` is never used.** GitHub's older anchor counts lines from the top of the patch, which silently means a *different line* the moment the pull request gets another commit.
- **A range is first-selected to last-selected.** `anchorFor` (`pendingReview.ts:47`) takes the last picked row as the anchor and the first as `start_line`, which is GitHub's own convention, and reads the selection in any order.
- **A selection spanning both sides narrows to the anchor row alone.** The API cannot express a range across two numberings, so inventing one would send a comment about lines the server would resolve differently. The narrowing is shown through `anchorLabel` (`pendingReview.ts:74`) rather than applied silently.
- **The review is held, then submitted once.** A review is atomic on the server: one call carries the verdict, the body and every comment. Posting comments as they are written and the verdict at the end leaves a half-submitted review behind whenever the last call fails, with nothing saying which comments landed. A failed submit hands the whole set back untouched.
- **Reading a thread needs the same two numbers.** `ReviewThread` carries `startLine` as well as `line` (added in Phase 12), because Sway itself writes ranges, so a reader that knew only `line` would narrow a range it had just written.
- **Verdict gating is the server's, restated.** `submitBlock` (`pendingReview.ts:112`) disables approve and request-changes on a self-authored pull request with the reason on screen rather than hiding them, and treats an unknown viewer as blocked too: not-yet-known is not known-different. Request-changes additionally requires a summary, which is Sway's own rule, because a verdict that says change something without saying what is not actionable.

## Why it's this way

The target repo is private and single-owner, so **every pull request Sway opens is self-authored**, and GitHub answers 422 to approve and request-changes from the author. Hiding those two verbs would make the build look like it lacked the feature; greying them with the constraint spelled out says which of the two it is. The atomic-submit shape came from the same reading of the API: the server treats a review as one object, so any design that posts it in pieces owns a partial-failure state the server does not have.

## Related

- [[component_pull_requests_panel]] - the review bar and thread cards built on this
- [[concept_pr_diff_two_sources]] - where the rows being anchored come from
- [[concept_hunk_level_staging]] - the neighbouring case of line coordinates changing under a rewritten patch
- [[gotcha_github_refuses_approve_and_request_changes_from_the_pr_author]]
- [[gotcha_diffrows_reads_props_selection_once_per_row]]
