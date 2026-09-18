---
summary: whether a pull request can merge reads from the server's mergeableState, never worked out locally from checks alone
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phase 13; commit 945c1bd; `src/utils/mergeGate.ts`, `src/panels/Editor/PullRequests/MergeBar.tsx`"
---

# Mergeability is asked, never worked out

Whether a pull request can merge is the server's answer, not a conclusion Tori draws. `mergeableState` accounts for branch protection, required reviewers and required checks, none of which are readable from this side. A locally derived verdict would render an enabled button the server then refuses, which is strictly worse than no button: the user learns it will not merge only after asking it to.

## How it works

- **One record, one entry per state** (`mergeGate.ts:36`), written as a total `Record<MergeableState, MergeGate>` rather than a `switch` with a default. A state added to the union fails to compile here instead of falling through to whatever the default said, which for a merge gate means a live button on a verdict nobody read.
- **`block` is a boolean, not a reason string.** `summary` is already the sentence on screen; a second copy as a reason would be a string nothing renders and everything has to keep in step with.
- **`unstable` merges.** GitHub allows it: the failing checks are not required ones. Blocking it here would be Tori overruling the server in the direction that merely *looks* careful, so it warns and says why.
- **`blocked` is deliberately vague.** `mergeableState` says *that* a rule holds the merge, never which. "Needs one approval" would be a sentence Tori invented; the server's own wording arrives with the 405 refusal, and that is the only place specifics appear.
- **`dirty` is offered no update.** Being behind is part of the story, but `update-branch` is itself a merge, so the button would fail at exactly the conflict it appears to fix. Only `behind` gets it.
- **An unread verdict is not a verdict.** `null` (nobody has asked) falls through to `unknown` (GitHub has not decided), and both block, for the same reason: nothing has said this can merge, so nothing may offer to.
- **The verdict is re-read after an update, never assumed.** `update-branch` answers 202 (queued), so the state after it is a question, not a known.
- **All three methods are offered and the server refuses.** A repo can forbid squash or rebase and that setting is not readable from here; hiding a method on a guess would remove the one the repo requires.

## Why it's this way

This is the same shape as [[concept_evidence_tiered_attribution]]: when the authority is elsewhere, the app's job is to report what it was told and to be honest about not knowing, rather than to synthesize a confident answer. The temptation here was a review-derived gate (block until approved), which on a single-owner repo would block every merge Tori ever offers, since the author cannot approve their own pull request, and the server would have been happy to take all of them.

## Related

- [[component_pull_requests_panel]] - the merge bar this drives
- [[concept_review_line_anchoring]] - the other place the author-is-the-viewer constraint bites
- [[concept_evidence_tiered_attribution]] - the same discipline about facts Tori does not own
- [[component_worktree_lifecycle]] - where deleting the merged branch is routed
- [[gotcha_graphql_mergeable_is_not_rest_mergeable_state]]
- [[gotcha_update_branch_answers_202_and_a_refused_merge_answers_405]]
