---
summary: computeSessionDot returns early for chat sessions, so a chat based needs you check cannot prove the PTY tier works
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown (branch `navigation`, phases 3-6); `src/utils/sessionStatus.ts` `computeSessionDot`; commit 61eb767; see [[concept_session_certainty_tiers]]
---

# Only the PTY tier can starve, so a chat-based needs-you test proves nothing

Do not verify the needs-you pipeline with a chat session. `computeSessionDot` returns on `chatStatus` on its first line, so a chat never reads `tailState`; only the PTY tier performs the quiet-x-tail join and only it can be starved by an empty session store. Why: a chat-based check passes against a build where the PTY tier is completely broken. Use a PTY agent tab.
