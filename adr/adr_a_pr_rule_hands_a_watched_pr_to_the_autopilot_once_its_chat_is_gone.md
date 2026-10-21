---
summary: a PR rule files a ship item from a watch's news only once the chat is gone; fresh PR-head worktree, gated pr.push, sticky hourly pause
status: current
updated: 2026-10-22
source: gettori/tickets#44 on branch evernt-automation, plan "Event rules: queue a ship item when a watched PR needs work"; commits 5718fccb, df4d2c0a; src-tauri/src/rpc/pr_rules.rs, src-tauri/src/autopilot.rs (plan_rule_firings, rule_paused), src-tauri/src/rpc/office.rs (pr_rules_tick), src-tauri/src/rpc/methods.rs (pr_push)
---

# A PR rule hands a watched pull request to the autopilot once its chat is gone

## Context

gettori/tickets#44 asked for per-project rules, "on forge event X, do Y", over five events and four actions. PR watch already detected changes requested, a failed check and a conflict, but only for a watched PR, and it only wakes the watching chat while that chat is live ([[adr_a_pr_watch_rides_the_poll_and_wakes_only_an_idle_chat]]). With the chat closed the news waited on disk and nothing started work. Issue labelled had no data (`IssueRef` carries no labels), and nothing pushed to an existing PR.

## Decision

- **PR events on watched PRs only.** A rule reads a watch's pending `News`. It adds no polling and keeps the comment-only cap.
- **Only once the chat is gone.** `session_ended`: absent from `SessionStates.shown()` or `Ended`. Idle, working and needs-you chats keep their normal wake, so a worker and a chat never edit one branch.
- **One action: a ship item.** It is `Source::Rule { pr, repo, event }`, `proposed` or `queued` per the contract's pickup. Gated like pickup: there is none while the autopilot feature is off or the project has no contract. One open item per PR. A hit on a PR an open item already holds hands the watch to that item.
- **The watch is handed over.** It ends with "handed to the autopilot", and the autopilot hears later news through the item's `pr_url`.
- **A fresh worktree at the PR head** (`worktree_new` with `pr`), never the chat's.
- **`pr.push` for an existing PR.** It pushes an exact sha, never forced, to an open origin PR's own head ref, behind `gated_outward`.
- **The pause is sticky and derived.** `max_per_hour` firings inside any one hour since `resumed_at` pause the rule until a person resumes it. Only `resumed_at` is stored, in `rules.json`.

## Alternatives rejected

- **The full grid.** Labelled needs a new fetch, notify-only needs a path not tied to a session (the Inbox is chat-only), and "wake the watching chat" is what PR watch already does.
- **Watching every open PR you authored.** More alias reads and a watch with no session.
- **Diffing the coarse branch status.** No remark detail, and capped at 20 branches.
- **Always a worker, or both a worker and the chat.** The first overrides a chat that is present; the second puts two agents on one branch.
- **`Kind::Ship` on `Source::Pr`.** `Source::Pr` means a review request to pickup's matching and closing, so a rule item could close as "review request cleared".
- **Reusing the chat's worktree.** A reopened chat would share it, and a chat that ran in the project root would hand over the main checkout.
- **Shipping local, with you pushing by hand.** Nothing would reach the PR without a manual step.
- **A rolling-hour pause, like the review rule's stored `fired`.** It lifts on its own, and stored facts drift ([[adr_autopilot_stores_decisions_and_derives_facts]]).

## Consequences

- A rule hears nothing for a PR nobody watches, and nothing while the window is closed (the watch rides the webview poll).
- A reopened chat finds its watch ended. Watching again is allowed, and its next hit goes to the open item.
- A fork's PR is refused by `pr.push`.
- `pr.push` is a second push row beside `pr.create`. That doesn't contradict [[adr_pr_create_pushes_the_approved_sha]], whose rejected `branch.push` was about creating a PR.

## Related

- [[component_pr_rules]]: the implementation
- [[component_pr_watch]]: the news it reads
- [[adr_a_schedule_queues_an_item_and_never_starts_a_worker]]: the same "queue, never spawn" rule
- [[adr_a_background_session_needs_a_tori_gate]]: the gate `pr.push` sits behind
