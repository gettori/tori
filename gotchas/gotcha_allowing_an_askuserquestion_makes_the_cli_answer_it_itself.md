---
summary: allowing an AskUserQuestion call runs it against a client that is not there, so the cli self answers in 5ms
status: current
updated: 2026-08-22
source: plan "Answer AskUserQuestion inside the chat panel" (phase 0), branch `chat-transcription`; `dev/protocol-probe.mjs` scenario `ask-user-question`; `src-tauri/src/chat/claude_transport.rs`
---

# Allowing an AskUserQuestion makes the CLI answer it itself

Do NOT answer a `can_use_tool` for `AskUserQuestion` with `{"behavior":"allow"}` expecting the question to stay open. Why: allowing runs the call against an interactive client that does not exist on this transport, so the CLI self-answers within about 5ms with `The user did not answer the questions.` and the turn continues as though the user shrugged. A deny is the only answer with a field that carries text, so a real answer ships as a denial and arrives `is_error: true`, which 20 of 20 measured runs acted on without re-asking. The `No response after 60s` string is the interactive TUI's and never appears here, so a park that looks like a timeout is not one.
