---
summary: do not read a session's rate limit from the needs-you log, its LimitHit row is added once per account and reset
status: current
updated: 2026-10-27
source: gettori/tickets#46 on branch agents-launching-agents, plan "Agents launching agents: wait reasons, check, handoff, loop", commit 9ad18c06; src-tauri/src/needs_you_log.rs (note_limit, limit_row); src-tauri/src/rpc/office.rs (rate_limit, rejected_until)
---

# The needs-you limit row is once per account and reset

Don't answer "is this session limited" from the needs-you log's `LimitHit` row. Its id is `limit-hit:<account>:<resets_at>` and it is written with `add_once`, so only the first session on that account to hit the limit gets one, and a second session waiting on the same reset finds nothing. Why: the row exists for the digest, which wants one line per account hit, not one per session. Read the live event instead: `ChatHost::wrap` forwards every non-replayed `RateLimit` through `rpc::rate_limit_heard`, and `Office::rate_limit` records a rejected one per session in `SessionStates::limit_resets_at`. Neither the ACP mirror nor history keeps the event.

## Related

- [[component_app_socket]]: `session.wait`'s `limited` reason
- [[component_needs_you_log]]: the log the row lives in
