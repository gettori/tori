---
summary: digest.rs reads Since you looked out of the needs-you log, lines counted from checkpoints at read time, since pinned while shown
status: current
updated: 2026-10-12
source: "Morning digest plan (branch `phase-1-block-2`, gettori/tickets#37); commits abaeddaa, f87eb5be, 52202880, cc1f31f3; `src-tauri/src/digest.rs`, `src/utils/digest.ts`, `src/panels/Inbox/InboxView.tsx`, `mobile/src/Inbox.tsx`"
---

# Since you looked digest

`src-tauri/src/digest.rs` builds the Inbox's Since you looked tab: what finished, what happened to pull requests and usage limits, and what still waits, since the person last saw it. It stores nothing of its own; every fact lives in [[component_needs_you_log]].

## Responsibility

- **Finished sessions.** Done rows after `since`, grouped per session with turns, first and last time, and the session's latest verdict. Lines are counted at read time by `checkpoint::session_lines_since` from the turn running at the first Done row to the latest, for chats only, because a Done row knows its session but not its turn and git work does not belong in the composition tick ([[gotcha_checkpoint_range_diff_files_carry_no_line_counts]]).
- **Happened.** `prOpened`, `prMerged`, failing `pullRequest`, `limitHit`, `limitResumed` rows after `since`.
- **Waiting.** Every unanswered block, however old.
- **`ready`.** True once the first composition after launch has run. The log's load answers every open block, so before that the waiting list is short; the launch auto-open waits for it. `record` reports the first composition as a change so the webview hears it.
- **Does not** decide when to open or when the person looked; the clients do.

## Interface

- Tauri `digest_list(since?)`, `digest_looked(at)`, `digest_limit_resumed(sessionId, folder, resetsAt)`; RPC `digest.list` and `digest.looked` on `LOCAL_AND_DEVICES`, refused to agent sessions.
- The limit hit is noted by the chat host on a live rejected `RateLimit`, the account named from the ownership registry. The resume is reported by ChatView's resume fire, which receives its `Arm`, for the setting and the banner alike.
- Desktop `src/utils/digest.ts`: the store, the shared row formatter (`finishedParts`, `happenedParts`, `digestTime`), and `watchDigest`, which opens the Inbox on the tab at launch and after four hours away. Away is input idle, not lock or sleep events: focus, pointer and key reset it, blur starts it, so a locked Mac with Tori in front counts with no native hook.
- Phone `watchDigest` in `mobile/src/Inbox.tsx`, same rules, marking seen on tab unmount or the document going hidden.
- Both pin `since` while the tab shows, so reading does not empty it, and pass the `asOf` they read to `looked`.

## Related

- [[component_needs_you_log]] where every fact lives
- [[component_turn_checkpoints]] the trees lines are counted from
- [[adr_the_digest_mark_moves_only_when_the_digest_was_seen]] what "since" means
- [[gotcha_a_factory_called_inside_a_jsx_prop_reruns_on_every_read]] the trap the phone test hit
