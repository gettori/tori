---
summary: GitHub's assigned search stops at first 50, so a row absent from a full list may be cut off, not unassigned; close nothing
status: current
updated: 2026-09-25
source: gettori/tori#210 on branch orchestrator; src-tauri/src/issues/github.rs (ASSIGNED_CAP); src-tauri/src/autopilot.rs (plan_pickup)
---

# An assigned list at the search cap proves nothing missing

Do NOT close an item because the assigned list left it out when that search came back with `ASSIGNED_CAP` rows (`src-tauri/src/issues/github.rs`). Each of the two searches asks for `first: 50` and nothing pages, so the 51st assignment is simply not in the answer. Why: pickup reads absence as "unassigned or closed upstream" and winds the worker down, so a truncated list would end live work for nothing. `plan_pickup` checks the issue and review searches apart, since one can be full while the other is whole.

## Related

- [[adr_assigned_pickup_rides_the_forge_poll_tick]]: the drop rule this guards
- [[component_issue_source]]: `list_assigned`
