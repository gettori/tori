---
summary: a PR watch reads by number inside the project's one poll request and wakes only a live idle chat, filtering by posted ids, not login
status: current
updated: 2026-10-04
source: plan "Let a session watch a pull request and wake on changes" on branch watch-pull-request, ticket gettori/tickets#4 (brief comment issuecomment-5978246802); commits ee33dbd9, ce84d7f4, 158fc1df; src-tauri/src/rpc/pr_watch.rs, src-tauri/src/rpc/pr_wake.rs, src-tauri/src/forge/github.rs
---

# A pull request watch rides the poll and wakes only an idle chat

## Context

After a session opened a pull request, nothing told it when a check failed, someone commented or the branch started to conflict. The autopilot heard this for its own items; an ordinary chat polled with `sleep` or waited for the user. t3code solves it with a watch the server checks every minute. Tori's constraints differ: the hourly GitHub budget shapes the poll ([[concept_forge_rate_budget]]), every wake is a paid turn, the agent posts under the user's own GitHub login, and the spend ceiling lives in the webview.

## Decision

- A setting, `forge.prWatch`, off by default. Off means no tool is listed, a call is refused, and no watch runs.
- A watched PR is a `w{n}: pullRequest(number:n)` alias inside the project's existing batched status query, on the existing 120 s tick. Detail (comments, reviews, run ids, `isRequired`) is asked for watched aliases only.
- The agent may start a watch itself through `pr.watch`; the user can from the branch row. Autopilot items' sessions are refused, since the autopilot already gets their `pr` lines.
- A wake goes only to a live chat that `SessionStates` reports `idle`, after 10 s of quiet and at most once per 5 minutes. With no live process the news waits on disk; Tori never spawns a harness to deliver it.
- Remarks are filtered by the ids Tori posted for the watching session, not by author login.
- Delivery is a sibling module, `pr_wake.rs`, beside the autopilot watcher.

## Alternatives rejected

- **t3code's 60 s poll**: twice the budget, for checks that take minutes.
- **A follow-up request per PR when a count moves**: costs a request per change and needs a cap on watches. The alias costs no request.
- **Widening the `headRefName` alias**: two fork PRs from branches of one name read as one, and the branch competes with the tick's cap.
- **Filtering by login**: the agent and the user share one GitHub account, so the user's own comments would never wake the session. Known gap of the id filter: a comment the agent posts through `gh` from its shell wakes it, which the 10 comment-only wakes stop bounds.
- **Asking the webview over the bridge whether the chat is stopped**: a budget-stopped chat already reports `needs_you` (`socketState`, `src/utils/sessionStatus.ts:113`), so gating on `idle` holds it with no round trip. Routing through `pendingFlush` would need a mounted tab.
- **Resuming a closed chat in the background**: it pulls in the background flag and its gate ([[adr_a_background_session_needs_a_tori_gate]]) for an unseen paid turn.
- **Generalising `watcher.rs`**: it is built around one delivery target gated on the runner's state; many targets would rewrite tested autopilot code.

## Consequences

- A watch hears nothing while the window is closed or the project's poll is paused, which is why `pr.watch` refuses a paused project.
- Watched projects are polled outside the active space, through `pr_watch_polled` and `pr_watch://changed`.
- Third-party text now reaches an agent's turn, so the wake text is cleaned and framed as data ([[gotcha_a_tori_note_body_can_close_its_own_note]]).
- GitLab answers no watched reads; the trait default returns none.

## Related

- [[component_pr_watch]]: the implementation
- [[component_autopilot_watcher]]: the rules it copies
- [[adr_autopilot_is_a_session_not_a_state_machine]]: the same "woken, never polled" principle
- [[concept_spend_ceilings]]: the ceiling a Rust-sent turn has to respect
