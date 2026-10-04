---
summary: ChatView's sendBlocks skips the spend ceiling, only onSend and pendingFlush check it, so any other send must check stopped() itself
status: current
updated: 2026-10-04
source: plan "Resume a session when its usage limit resets" on branch resume-a-session, ticket gettori/tickets#3; src/panels/Chat/ChatView.tsx:1227 (sendBlocks); src/panels/Chat/chatStore.ts (pendingFlush, turnCompleted)
---

# sendBlocks does not check the spend ceiling

Don't send a turn Tori starts by itself through `sendBlocks` without checking `stopped()` first. `sendBlocks` (`src/panels/Chat/ChatView.tsx:1227`) only draws the turn and invokes `chat_send`. The ceiling is enforced one level up, in `onSend` and `pendingFlush`, so a send that goes through neither gets past a stopped chat. Why: the ceiling is held at the turn boundary in the webview ([[concept_spend_ceilings]]), and nothing on the Rust side refuses a turn over budget.

The second half of the same trap: an `errored` turn sets `queueHeld`, and only `releaseQueue` (the "send now" button) clears it. Messages typed during the stop stay parked after a turn Tori sent by itself has finished, unless that send releases the hold, which is what `continuing` does in [[concept_resume_at_reset]].

## Related

- [[concept_spend_ceilings]]: where the ceiling lives
- [[concept_resume_at_reset]]: the send that walked into this
