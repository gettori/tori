---
summary: GitHub's 5000 requests an hour means Tori batches one GraphQL call per project per tick, never one per branch unit
status: current
updated: 2026-09-24
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phase 5; commit 8aedaed; `src/utils/forgePoll.ts`, `src/utils/forgeStatus.ts`, `src-tauri/src/forge/status.rs:63`; gettori/tori#202 commit f8a61936, `src-tauri/src/issues/gate.rs`"
---

# The forge rate budget (why a tick asks about a project)

GitHub allows 5,000 requests an hour per account. Tori watches N branch-units across every open project and wants three facts about each (pull request, checks, review decision), so the naive shape (one request per unit per concern per tick) spends the whole hourly budget on an idle window nobody is looking at. The budget is therefore not a limit to respect at the edges, it is the constraint the whole poll layer is shaped around: **one batched GraphQL request per project per tick, never one per unit.**

## How it works

- **Rust plans the tick.** `plan_tick` (`status.rs:63`) takes the project's branches and a cap, and returns what to ask about plus how many units it could not cover. The uncovered count is carried rather than dropped, so the sidebar can say "not everything here was checked" instead of implying a clean answer.
- **The decisions are pure, the timer is not.** `forgePoll.ts` holds every judgement with its inputs explicit: `pauseReason` (disabled / signed out / suspect credential), `mayPoll` against a `PollClock`, `askOrder` (visible units first, because the tick may not reach all of them), `backoffAfter` for a refusal and `budgetBackoff` for a budget that is running low. `forgeStatus.ts` owns the interval, the invoke and the signals. Same split as `sessionActivity.ts`, for the reason in [[lesson_pure_core_for_global_stores]].
- **Backoff reads the server, not a guess.** `classify` (`http.rs:203`) takes `X-RateLimit-Reset` off the refusal itself, so a primary-limit backoff waits exactly as long as GitHub says rather than a constant somebody picked.
- **Two scopes of backoff.** A primary rate limit is an *account* fact and pauses every project; a secondary limit or a repo-level failure is a *project* fact. Collapsing them would either over-pause the app or keep hammering the endpoint that refused.
- **Caches and single-flight sit in Rust** (`status.rs:198` `SingleFlight`, `status.rs:78` `StatusCache`, `prs.rs:37` `PrCache`), so two triggers landing together (a focus event and an interval) make one request, and a panic inside a flight does not strand the callers waiting on it.
- **Landing a pull request invalidates the whole repo.** `landing()` (`commands.rs`) drops both caches for that repo, and only on success. A merge changes every branch's answer, not just its own.
- **Issue calls carry their own gate, in Rust.** The backoff above lives in the webview, and a socket caller (the autopilot, the CLI) never passes through it. So every issue call goes through a per-account gate that closes on a `RateLimited` answer until the host's own deadline and refuses locally until then; an offline failure says nothing about the budget and leaves it alone. The assigned list is fetched on demand, not on the tick, behind a `FRESH_FOR` cache and a `SingleFlight`. See [[component_issue_source]].

## Why it's this way

The plan named the rate budget the binding constraint before any code was written, and it shaped four phases. The alternative (per-unit polling with aggressive caching) was rejected because caching only shifts *when* the budget is spent: a project card can hold up to `BRANCH_CAP` units, and a user with several projects open would exhaust the hour by lunchtime doing nothing. Batching per project makes the cost scale with projects rather than branches, which is the number that stays small.

## Related

- [[concept_forge_provider_seam]] - where the batched query and the rate snapshot live
- [[component_forge_client]] - the Rust half (plan, cache, single-flight)
- [[component_pull_requests_panel]] - the sidebar chips and panel this feeds
- [[lesson_pure_core_for_global_stores]] - the split this layer follows
- [[lesson_never_hold_a_cache_lock_across_a_network_call]] - the bug this layer's cache hit
- [[component_issue_source]] - the on-demand caller that needed a gate of its own
