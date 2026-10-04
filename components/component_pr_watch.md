---
summary: rpc/pr_watch.rs keeps what a chat's PR watch last told it; rpc/pr_wake.rs sends the news as one Tori note once the chat is idle
status: current
updated: 2026-10-04
source: plan "Let a session watch a pull request and wake on changes" on branch watch-pull-request, ticket gettori/tickets#4; commits ee33dbd9, ce84d7f4, 158fc1df; src-tauri/src/rpc/pr_watch.rs, src-tauri/src/rpc/pr_wake.rs, src-tauri/src/forge/github.rs (unit_statuses_watching), src-tauri/src/rpc/table.rs (pr.watch, pr.unwatch), src/utils/prWatchMenu.ts
---

# Pull request watch

`src-tauri/src/rpc/pr_watch.rs` and `src-tauri/src/rpc/pr_wake.rs`: a chat watches one of its pull requests and is woken with what changed, behind the `forge.prWatch` setting (off by default).

## Responsibility

- **The record.** One `Watch` per (session, PR url) in `~/.config/tori/pr-watches.json`, holding what the session was last told: head sha, failed check run ids, passed, the remark cursor (`remarksThrough` plus the ids at that instant), conflicting, the comment-only wake count, failing-read and unseen-poll counters, `pending` news and `toriPosted` ids. Written through `PrWatches::update` (`pr_watch.rs:368`), which computes under the store lock, so a watch started during a poll is never lost.
- **The rules.** `Watch::compare` (`pr_watch.rs:158`), ported from t3code: a failed check run is told once by run id (a rerun is a new id, so it is told again); passed is told once over required checks, or every check when none is required; a new head resets the check state; a conflict is told on the change; remarks count only after the watch started and when the session did not post them through Tori; `unknown` mergeability, an empty check list and a snapshot without detail keep the last state. It ends on merge or close, 10 comment-only wakes in a row, 15 minutes of failed reads, or 8 polls without the PR, each with a last `Ended` line.
- **The read.** Each watched number is a `w{n}: pullRequest(number:n)` alias inside the project's one batched status query (`github.rs:838`, `watched_fields` at `github.rs:548`), with recent comments and reviews, check run `databaseId` and `isRequired`. `forge_unit_statuses` folds the read into every watch on the repo (`pr_watch::fold`, `pr_watch.rs:465`). A cache hit or a coalesced flight reads nothing, which counts as neither seen nor unseen.
- **Delivery.** `pr_wake.rs` sends a session's pending news as one `from_tori("pr_watch")` turn once it has been idle 10 s, at most once per 5 minutes (`Core::due`, `pr_wake.rs:54`). Ready means the setting is on, `SessionStates` reports `idle` and `ChatHost::is_live`. A wake clears only the news it rendered (`Watch::delivered(told)`).
- **The wake text.** `render` (`pr_watch.rs:266`) lists at most 10 items, quotes third-party text on one line through `clean` (`pr_watch.rs:302`), and says a wake is news, not a merge decision.

It does not own the poll clock, the rate budget or the forge credential ([[concept_forge_rate_budget]]), and it never resumes a chat to deliver.

## Interface

- Socket and `tori mcp`: `pr.watch` and `pr.unwatch`, chat callers only, hidden from `tools/list` while the setting is off (`table::offered`, `table.rs:524`) and refused anyway. `pr_watch::admit` and `watchable` hold the refusals: setting off, an autopilot item's session, a paused forge poll, a non-GitHub URL, a closed PR.
- `review.submit` records the posted review's node id in the session's watch (`Forge::submit_review` answers it).
- Tauri: `pr_watch_polled` and the `pr_watch://changed` event feed the webview poll, so a watched project is polled outside the active space; `pr_watch_list`, `pr_watch_start` and `pr_watch_stop` back the branch row menu (`src/utils/prWatchMenu.ts`) and the eye on `PrLine`.
- `sessions::delete_session` drops a deleted session's watches. Closing a tab does not.

## Related

- [[adr_a_pr_watch_rides_the_poll_and_wakes_only_an_idle_chat]]: why it is shaped this way
- [[component_autopilot_watcher]]: the sibling it copies its delivery rules from
- [[concept_tori_notes]]: the `pr_watch` note
- [[gotcha_a_tori_note_body_can_close_its_own_note]]: why the wake text is cleaned
- [[gotcha_forge_epoch_secs_is_not_iso_8601]]: the parser the remark times need
- [[concept_spend_ceilings]]: why delivery gates on the reported state
