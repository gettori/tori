---
summary: push-side decisions (Diverged, force push lease, cherry limit, Push refusing) measure HEAD against origin/<branch>, never the upstream
status: current
updated: 2026-10-11
source: plan "Pull, Pull (Rebase) and Push say what they will do to this branch" (gettori/tickets#73, branch phase-1-block-2); `src-tauri/src/git.rs:2645` `push_target`, `src-tauri/src/git.rs:2556` `force_push_branch`, `src/utils/pushWords.ts` `divergedTarget`
---

# The push target is origin/<branch>, not the upstream

A push always writes `refs/heads/<branch>` on origin (`push_branch` runs `git push origin <branch>`), but the counts the sync pill and sidebar read follow the configured upstream, `<branch>@{u}`. Those are often the same ref and sometimes not: `git checkout -b feat origin/main` sets `feat`'s upstream to `origin/main`. Anything that decides what a push will do therefore measures against `refs/remotes/origin/<branch>`, which `git_ahead_behind` reports as `push_target` (`ahead`, `behind`, `sha`), or null when that ref does not exist yet.

## How it works

- **Diverged** (`divergedTarget` in `src/utils/pushWords.ts`) is `push_target` with both counts above zero and the upstream not `superseded`. It drives the Diverged pill, the refused Push row, the Force Push entry, and `refuseIfDiverged`, which palette Push and Sync call first.
- **Force push** (`force_push_branch`) leases on an explicit sha, `--force-with-lease=refs/heads/<branch>:<sha>`, where the sha is `push_target.sha` as the confirm showed it. The bare `--force-with-lease` leases on the tracking ref, which any background fetch moves, quietly disarming the lease.
- **The copy check** (`push_duplicates`) runs `git cherry origin/<base> HEAD origin/<branch>`, so only the commits this push adds are counted, and none at all past a ref the push does not write to.

## Why it is this way

Measured against an `origin/main` upstream, a feature branch reads diverged every time main moves. That would refuse a valid first push and aim the lease at the wrong ref. The sidebar's own sync still follows the upstream: it answers a different question (how far behind what you track), and changing it was out of scope.

## Related

- [[adr_pr_create_pushes_the_approved_sha]]: the other push that pins an exact sha
- [[gotcha_a_pruned_upstream_reads_as_never_pushed]]: the upstream side's own trap
- [[gotcha_a_cherry_pick_inside_the_same_second_is_the_original_commit]]: what the copy check's test tripped on
