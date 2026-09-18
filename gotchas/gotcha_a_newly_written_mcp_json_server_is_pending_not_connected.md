---
summary: a server tori writes to mcp.json loads as pending, approval lives in a file tori deliberately never writes
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (personal/tori, branch `chat`); Phase 12; `src-tauri/src/chat/mcp.rs`, `src/panels/Chat/SessionInfo.tsx`
---

# A newly written `.mcp.json` server is pending, not connected

Do NOT expect a server Tori writes to `.mcp.json` to be live in the next session. Claude loads an unapproved `.mcp.json` server as **pending** and does not connect to it (`claude mcp list` shows `⏸ Pending approval`). The approval lives in `projects[<cwd>].enabledMcpjsonServers` inside `~/.claude.json`, which is the file we deliberately never write, so the state cannot be cleared from Tori. Report it with the instruction for clearing it rather than force-enabling it. Related: [[concept_mcp_config_scopes]].
