---
summary: an ACP agent can still ask to write a file after declining that capability, refusing is fine, not answering hangs it
status: current
updated: 2026-08-14
source: Defer permissions to the harness, and grow to four harnesses, phase 6 (personal/tori, branch `chat-fix`); [[concept_acp_agent_quirks]]
---

# An ACP agent may ask the client to write a file it declined to write

Do NOT treat a declined client capability as a promise the agent will not ask. `opencode acp` sent `fs/write_text_file` with `readTextFile`, `writeTextFile` and `terminal` all declined at `initialize`. Refusing is safe - the agent falls back to writing the file itself - but the client must **answer**, since an unanswered request hangs the agent. The SDK's default handler answers, which is why this can sit undetected for a whole phase.
