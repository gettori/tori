---
summary: steering a running turn needed its own transport verb, since reusing send would consume a switch queued for next turn
status: current
updated: 2026-07-29
source: Chat surface plan, phase 8 (branch `chat`); `src-tauri/src/chat/` (`AgentTransport::steer`, `ChatCommand::Steer`, `chat_steer`); `src/panels/Chat/chatStore.ts` (`steerable`); commit "Steer a running turn instead of queuing behind it"
---

# Mid-turn steer

Sending a message *into* a running turn, redirecting it, rather than queuing
behind it. Measured at 1.5s to 5.4s from send to the model acting, with every
remaining tool call pre-empted, so the composer says a steer is picked up at the
agent's next step rather than presenting it as instant.

## How it works

**`steer` is its own transport verb, and the reason could not be reasoned from
the spike.** `ClaudeTransport::send` flushes a queued mode or model switch before
writing the turn frame, and `take()`s it. Reusing `send` for a steer would
therefore apply a switch the UI had promised would wait for the *next* turn, and
consume it, so the turn it was meant for never got it. Hence `AgentTransport`
grew `steer`, `ChatCommand` grew `Steer`, and `chat_steer` sits beside
`chat_send`. It writes the identical `user` frame and nothing else;
`a_steer_leaves_a_queued_mode_or_model_switch_for_the_next_turn` pins the
difference from both sides.

**The queue was narrowed, not replaced, and the line is the child's own
acknowledgement.** `steerable` requires `activeTurnId`, not merely `isRunning`.
Between Enter and `turnStarted` a turn is in flight but has not begun, so there
is nothing to steer and a second `user` frame there would race the first rather
than redirect it. That window still queues, which leaves the stop-does-not-flush
guarantee intact rather than deleting a mechanism that still has a job.

**A steer keeps the user row rather than becoming a notice**, since it is the
same message from the same person; it is indented, labelled and given its own
icon because it landed *inside* the turn above it. It opens no turn group for
free: `turnOpeners` counts assistant-side rows only, so the interrupted turn
keeps its one byline. A replayed `userMessage` is never marked as a steer, since
the wire frame carries no such distinction and guessing would label a message
nothing recorded.

## Why it's this way

**What could be verified offline, and what could not.** A spike established that
claude acts on a mid-turn `user` frame before its next tool call; what it could
not establish is that Tori's own path still writes that frame once it stopped
going through `send`. So `a_steer_writes_the_user_frame_to_the_live_childs_stdin`
runs the real transport against a `/bin/sh` stand-in that copies stdin to a file
and asserts on the bytes that left the pipe. The end-to-end half remains an
observation at n=3 against one CLI version, and `steerable` is the single
predicate to turn off if a later version starts buffering to turn end.

**A refused steer must not eat the message.** `Composer.submit` clears the input
the moment `onSend` returns, and a steer resolves long after that, so a session
blocked on a permission prompt refused the steer and lost the text with it. This
is the first send that can fail after the composer has already cleared, so
`restoreDraft` puts the text back, but only into a still-empty composer, since
restoring over something typed in the round trip would lose the newer text to
save the older.

## Related

- [[component_chat_host]] - where the transport verb lives
- [[component_chat_panel]] - the composer, the indented steer row, the draft restore
- [[concept_transport_neutral_event_model]] - why a new verb needed a neutrality check
- [[concept_harness_capability_tiers]] - `canSteer` also requires the measured value
- [[gotcha_a_stream_json_cli_reads_stdin_until_eof]]
