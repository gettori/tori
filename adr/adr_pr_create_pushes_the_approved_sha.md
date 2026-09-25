---
summary: pr.create pushes the exact sha the approval names to its head branch, never forced, then opens the PR; a moved branch is refused
status: current
updated: 2026-09-25
source: plan "Ticket flow: work on #N from issue to an approved PR" (gettori/tori#207) on branch orchestrator, commit 41e063de; src-tauri/src/git.rs (push_sha); src-tauri/src/rpc/methods.rs (pr_create); src-tauri/src/rpc/approvals.rs (Draft::PrCreate)
---

# pr.create pushes the approved sha

## Context

A worker makes its commits in a worktree on a branch that exists only locally, or on origin at an older commit. Nothing on the socket pushed, so `pr.create` failed on a fresh branch, and a push is itself outward: it has to sit behind the same approval as the PR ([[adr_a_background_session_needs_a_tori_gate]]).

## Decision

The `PrCreate` draft carries `head_sha`, and the approval card shows "a pull request from <head> at <sha> into <base>". `pr.create` requires it, for every caller. Under the repo lock and inside the approval gate it runs `git::push_sha`: it checks that `refs/heads/<head>` still resolves to that sha, else refuses with "moved, ask again", then pushes `<sha>:refs/heads/<head>` to origin through `git_command` with the askpass bridge, never forced. Only then does it create the PR (`prs::push_then_create`). Any error releases the approval, so a failed push or create can be retried with the same one; the push of the same sha is harmless the second time.

## Alternatives rejected

- **The worker pushes.** Outward and ungated: a worker's shell would reach the forge without the user's approval.
- **A separate `branch.push` row.** Two approvals per PR for one decision the user makes once.
- **Push whatever the branch holds at create time.** The user approved a commit, not a branch name; a commit landing between the approval and the call would ship unseen work.

## Consequences

- Pinning the sha mirrors `pr.merge`, which pins the head it approves.
- The autopilot's brief reads the head sha (`git rev-parse`) before asking, and passes it through.
- A branch that moved after the approval needs a fresh approval, by design.

## Related

- [[adr_a_background_session_needs_a_tori_gate]]: the gate the push sits behind
- [[component_app_socket]]: the `pr.create` row
- [[concept_askpass_bridge]]: how the push authenticates
