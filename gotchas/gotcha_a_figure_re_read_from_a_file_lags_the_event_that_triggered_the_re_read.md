---
summary: re reading a producer's file on the event that updated memory state shows the previous turn, prefer the live store
status: current
updated: 2026-07-30
source: Make the session controls tell the truth about the CLI, follow-up to phase 5 (personal/tori, branch `chat`); `src/panels/Chat/ChatView.tsx` (`liveDetail`), `src/panels/Chat/chatStore.ts` (`promptsSent`, `toolCallsSeen`), commit "Count compactions live, and stop showing two token numbers"; [[component_chat_panel]]
---

# A figure re-read from a file lags the event that triggered the re-read

Do NOT refresh a UI figure by re-reading the producer's file on the same event that already updated your in-memory state. The chat status strip took its figures from `chat_session_detail`, a re-scan of the transcript, fired from `createEffect(on(() => state.turnsCompleted, loadDetail))` - but the CLI has not necessarily flushed that turn to disk when the turn-completed event arrives, so the strip rendered the **previous** turn's numbers while the composer, reading the store, was current. The two disagreed on screen and the strip looked frozen. Prefer the in-memory value wherever the store is both live and *complete*, and keep the scan only as the baseline it is genuinely better at: it is the one thing that knows a resumed session's earlier turns. Completeness is per-figure and has to be checked, not assumed: prompts, tool calls and compactions are complete in the store because history replay emits their events (`chat/history.rs:95` for compactions), while **turns is not** - replayed history carries no turn frames, so `turnsCompleted` counts this run only and overriding with it would collapse a resumed session's count to whatever the window happened to watch. That one stays scanned on purpose.
