---
summary: a fix-loop project lets the autopilot push fixes to its own ship item's PR unasked, up to N; a person's remark stops it; merging always asks
status: current
updated: 2026-10-22
source: gettori/tickets#45 on branch fix-ci-until-green, plan "Fix CI until green, then ask to merge"; commits 40193aae, bb56adef, 02c357b4, 04ab48cd; src-tauri/src/rpc/methods.rs (fix_gate, pr_push), src-tauri/src/rpc/fix_loop.rs, src-tauri/src/rpc/pr_watch.rs, src-tauri/resources/autopilot/brief.md
---

# The fix loop pushes unasked and merges only on a card

## Context

gettori/tickets#45 asked for "keep fixing until the checks pass": each failed check wakes the worker with the log, under a cap of attempts and the spend ceiling, and green checks raise a Merge card, never a merge on its own. Until then every push to an existing PR went through `pr.push` behind `gated_outward` ([[adr_a_pr_rule_hands_a_watched_pr_to_the_autopilot_once_its_chat_is_gone]]), so a loop of three attempts meant three cards, and the autopilot only heard item PRs through the coarse `pr (#n; checks; review)` line, with no run ids and no comments.

## Decision

- **One switch per project**, `Settings.pr_fix_loop` (`prFixLoop`): `{ max_attempts: 3, stop_on_review: true }`, no entry is off. No per-item override.
- **Fix pushes skip the approval.** `pr_push` without an `approval_id` passes only for the runner's current session, only for an open `Kind::Ship` item whose PR is the draft's, only under the cap and while the loop is not stopped (`fix_gate` -> `FixGate`). The attempt is reserved on the item (`fix_pushes`) before the push and given back if the push fails. Every other caller still needs an approval.
- **The item watches its own PR.** An item-owned `Watch` in `pr-watches.json`, read whatever `forge.prWatch` says, gives run ids, passed and remarks ([[component_fix_loop]]). Its news replaces the item's `pr (...)` line.
- **A failed Actions job is rerun once per check per head** before anything wakes; a status context is told at once.
- **Rust fetches the log** with Tori's credential, through `pr.check_log` (last 300 lines), so it works without `gh` and for any harness.
- **A person's remark stops the loop**: any comment or review from a non-bot that is not an approval, with `stop_on_review` on. After that every push asks again.
- **Merging always asks.** On `checks_passed` with a mergeable state, the brief raises a `pr.merge` card, squash at the head that passed.

## Alternatives rejected

- **An approval per push.** Keeps "nothing leaves without approval" whole, but the loop would only save pasting logs.
- **A project default with an item override.** More UI and a stored field for a case nobody asked for.
- **The worker running `gh run view --log-failed`.** Needs `gh` installed and signed in as the right account.
- **The log tail inside the wake.** A fetch per failure even when nobody acts on it.
- **Stopping on the review decision only.** The coarse line has no comments, and a person commenting is exactly when to stop pushing unasked.
- **A remark reader just for item PRs.** Copies `Watch::compare`; an item owner on the watch reuses it.
- **Rust merging on green.** The ticket says never on its own, and the merge is the one step nobody can take back.

## Consequences

- This is the first push without an approval from a background session. The bound is the cap, the stop and the merge card, not the gate.
- The rerun is an outward write with no approval, accepted because it repeats what CI already ran.
- The loop needs the window open: the watch rides the webview poll, like every PR watch.
- A rule item gets a fresh item watch rather than its chat's, so a failure already on the PR is rerun once before it wakes.
- `Watch` marks an item watch with `item: Some(id)` and an empty `session`. An owner enum was put off as too wide a change.

## Related

- [[component_fix_loop]]: the implementation
- [[component_pr_watch]]: the watch it reuses
- [[component_autopilot_watcher]]: where the news wakes the autopilot
- [[concept_spend_ceilings]]: the ceiling the loop's Rust-sent turns respect
- [[adr_a_background_session_needs_a_tori_gate]]: the gate this carves an exception from
