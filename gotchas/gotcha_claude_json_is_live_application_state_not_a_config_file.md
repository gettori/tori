---
summary: claude.json is Claude's live running state rewritten by every open process, so a read-modify-write races and drops data
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (personal/sway, branch `chat`); Phase 12; `src-tauri/src/chat/mcp.rs`
---

# `~/.claude.json` is live application state, not a config file

Do NOT read-modify-write `~/.claude.json` to change MCP servers or anything else. Despite the name it is Claude's running state: ~90 top-level keys of onboarding flags, feature caches, per-project token totals and OAuth account, rewritten by every live `claude` process. A read-modify-write from Sway races those writers and can drop unrelated state nobody asked us to touch. Write the project-scoped `.mcp.json` instead (small, single-purpose, checked in, what `claude mcp add --scope project` writes) and treat the user and local scopes as read-only. Same boundary as the standing rule against writing `~/.claude/settings.json`. Related: [[concept_mcp_config_scopes]].
