---
summary: ChatHost::wrap sees only live events; a field it sets is gone on reopen unless history_reply and chat_history_page set it too
status: current
updated: 2026-10-08
source: "Secret watch plan (branch `phase-1-block-1`, gettori/tickets#28), phase detect-and-mark-turn; `src-tauri/src/chat/host.rs` (`wrap`, `cut_outputs`, `mark_secrets`), `src-tauri/src/chat/commands.rs` (`history_reply`, `chat_history_page`)"
---

# A change to live chat events in `wrap` misses replay

Don't treat `ChatHost::wrap` as the one place every chat event passes. Why: it wraps the live sink only. A reopened chat gets its events back from `chat_history` and `chat_history_page`, which return them straight to the caller, so anything `wrap` adds or cuts (an output cap, a secret mark) is missing from every replayed turn and the panel looks different after a reopen. Apply the same step in `history_reply` and the page command, the way `cut_outputs` and `mark_secrets` already are, and test both a live event and a replayed one. `chat_waiting` is a third exit but holds only permission and question requests.

## Related

- [[component_secret_watch]] the second change that had to be made twice
- [[component_history_tail]] where the replayed tail is cut
