---
summary: spawn_session with background true writes mcp_allow(true) into claude's settings, so a read-only worker must spawn foreground
status: current
updated: 2026-10-12
source: "Second opinion plan (branch `phase-1-block-2`, gettori/tickets#34); `src-tauri/src/chat/approval.rs:514`, `src-tauri/src/second_opinion.rs`"
---

# A background chat pre-allows Tori's MCP tools

`background: true` on a `SpawnRequest` does more than mark the session as a worker. It reaches `approval::settings_json_with`, which writes `mcp_allow(background)` into claude's permission settings, and the background list pre-allows Tori's outward tools. Claude then calls them without asking, so a permission handler that denies everything never sees the call.

A hidden worker that must stay read-only, like the second opinion reviewer, spawns with `background: false`. Every tool call then comes back as a permission ask the driver can deny.

## Related

- [[component_second_opinion]] the worker that hit it
