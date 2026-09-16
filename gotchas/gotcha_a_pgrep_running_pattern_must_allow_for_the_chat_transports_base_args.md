---
summary: an adapter running pattern anchored right after the program name misses every chat session, match a run of whole tokens
status: current
updated: 2026-07-28
source: plan "Native Claude chat as the default session surface" (personal/sway, branch `chat`); Phase 12; `src-tauri/agents/claude.toml`, `src-tauri/src/agents.rs`, `src/utils/agents.ts`
---

# A pgrep `running` pattern must allow for the chat transport's base_args

Do NOT anchor an adapter's `[running] pattern` to the flag sitting immediately after the program name. That shape (`claude (--resume|-r) {id}`) matches a PTY agent tab and **no chat session at all**: the chat transport puts its `base_args` first, so the real command line is `claude -p --input-format stream-json ... --resume <id>`, and a *new* chat is started with `--session-id` and never `--resume`. The original pattern silently returned false for every chat, making them invisible to `session_running` and so to the worktree-removal count, the delete-group warning, the revert guard's detached tier and the sidebar status dot. Match a run of whole argument tokens instead: `claude ([^ ]+ )*(--resume|-r|--session-id) {id}`, which spans the base args while still excluding a `tail` on the transcript. Related: [[component_agent_adapter_registry]].
