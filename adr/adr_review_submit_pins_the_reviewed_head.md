---
summary: a review draft carries the head sha the worker read; ask.create refuses a draft that can't post, review.submit re-checks and sends commit_id
status: current
updated: 2026-09-25
source: plan "Review flow: review PR N from a worktree on the PR head to one approved review" (gettori/tori#208) on branch orchestrator, commit b25293df; src-tauri/src/forge/pr_view.rs (check_review); src-tauri/src/rpc/methods.rs (postable, submit_pinned); src-tauri/src/rpc/approvals.rs (Draft::ReviewSubmit)
---

# review.submit pins the head the review was drawn against

## Context

The autopilot reviews a pull request through a worker in a worktree on the PR's head. The worker reads one commit; the approval card is shown later; the post happens later still. A review submitted with no commit is re-anchored by the host against whatever the diff is when it lands, so a push in between moves approved comments onto other lines. And GitHub refuses a whole review over one comment outside the diff, which after an approval would spend it on a draft that could never post.

## Decision

`Draft::ReviewSubmit` requires `head_sha`, and the approval names it ("a Comment review on #45 at <sha>"). Before the card shows, `ask.create` runs `pr_view::check_review` against a fresh `pr.get` view and refuses a draft whose head moved, whose verdict the host lacks (GitLab has no request changes), that approves or requests changes on the viewer's own PR, or that has a comment outside its file's hunks on its side or on a file with no patch. At submit, `review.submit` reads the PR's head again and refuses on a mismatch (the approval is released, not spent), then passes the sha to `Forge::submit_review`: GitHub sends it as `commit_id`, GitLab refuses when `diff_refs.head_sha` differs.

## Alternatives rejected

- **No pin.** A push between approval and post re-anchors the approved comments.
- **`commit_id` alone.** GitHub accepts an older `commit_id` without refusing ([[gotcha_github_takes_a_stale_commit_id_and_anchors_to_it]]), so an approval would land on a stale head.
- **Check the head without `commit_id`.** Leaves the window between the check and the post.
- **Anchor rules in the brief only.** A bad comment then fails with a 422 after the approval.
- **Check at submit only.** The approval is already given for a draft that cannot post.

## Consequences

- `Forge::submit_review` takes `head_sha: Option<&str>`: the Pull Requests panel passes none and posts unpinned as before.
- A PR that moves mid review ends the autopilot's item with a note; reviewing again means removing the `pr-<N>` worktree and asking again ([[component_worktree_lifecycle]]).
- `ask.create` now reaches the forge for every review approval, so a forge outage surfaces as an ask error rather than a card.
- `tori pr review` requires `--head-sha` ([[component_tori_cli]]).

## Related

- [[adr_a_background_session_needs_a_tori_gate]]: the gate the approval belongs to
- [[adr_pr_create_pushes_the_approved_sha]]: the same pinning for opening a PR
- [[concept_review_line_anchoring]]: the line and side rules the check enforces
- [[component_app_socket]]: the `pr.get`, `worktree.new` and `review.submit` rows
