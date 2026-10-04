---
summary: forge::epoch_secs reads `YYYY-MM-DD hh:mm:ss UTC`, not GitHub's ISO 8601 times; use acp_sessions::epoch_from_iso8601
status: current
updated: 2026-10-04
source: plan "Let a session watch a pull request and wake on changes" on branch watch-pull-request, ticket gettori/tickets#4, phase 2; src-tauri/src/forge/mod.rs:392 (epoch_secs), src-tauri/src/chat/acp_sessions.rs (epoch_from_iso8601)
---

# forge::epoch_secs is not an ISO 8601 parser

Do not parse a GraphQL `createdAt` or `submittedAt` (`2026-10-04T10:00:00Z`) with `forge::epoch_secs` (`src-tauri/src/forge/mod.rs:392`). It splits the date from the clock on a space, for token expiry headers and GitLab dates, so a `T` timestamp answers `None` and every remark silently drops out. Why: the name says forge, the format does not; `crate::chat::acp_sessions::epoch_from_iso8601` is the ISO 8601 one.

## Related

- [[component_pr_watch]]: where this bit
