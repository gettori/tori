---
summary: every result frame carries modelUsage with the real context window per model, a hand maintained table just drifted
status: current
updated: 2026-07-30
source: Make the session controls tell the truth about the CLI, phase 5 (personal/sway, branch `chat`); `src/utils/chatModels.ts` (`reportedWindows`, `contextWindowFor`), `src-tauri/agents/claude.toml`, `dev/fixtures/claude/plain-turn.jsonl`; [[concept_capability_resolution]]
---

# The harness may already report what you are about to declare

Do NOT design a rule for a value the running harness reports directly. A whole phase was planned to derive the context window ourselves: parse the `[1m]` suffix off model values, then encode "which providers grant the extended window" as a base/extended/providers table in the adapter TOML. None of it was needed. Every `result` frame carries `modelUsage[<id>] = { contextWindow, canonicalModel, provider, maxOutputTokens, ... }`, already accounting for model, provider and account, and it was **already riding `TurnCompleted.extra` into the UI unread** because the mapper forwards `modelUsage` wholesale. The measurement also showed the hand-maintained table was wrong where it mattered (Sonnet 5 and Opus 5 each declared 200000 against a reported 1000000), which is the drift a derived rule would have preserved rather than fixed. Grep the captured corpus for the concept before encoding a rule for it; a reported value cannot drift, because it is the running session describing itself. Keep a declared figure only as the pre-first-turn answer, since `modelUsage` does not exist until a turn ends, and mark it as provisional where it is written.
