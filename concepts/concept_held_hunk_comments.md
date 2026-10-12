---
summary: hunk comments are held per workspace in memory and one Send makes them a single turn for a chat or one placed line for a terminal
status: current
updated: 2026-10-12
source: plan "Hunk comments: hold several, send them as one message" (branch phase-1-block-2, ticket gettori/tickets#35); commit f3c9d00a; src/utils/heldComments.ts:22, src/utils/safeSend.ts:42, src/panels/Chat/ChatView.tsx:1205, src/panels/Terminal/Terminal.tsx:1671; second opinion plan (gettori/tickets#34), commit 3962a2b2, src/panels/Editor/HeldComments.tsx
---

# Held hunk comments

A hunk comment is held, not sent. The diff tab's bar and the Session pane count the workspace's held comments, and one Send delivers them all as one message, so a ten-hunk review is one trip rather than ten. "Send hunk comments right away" (Settings > Editor) brings back one send per comment.

## How it works

- **One list per workspace.** `heldComments.ts` keys on `workspaceKey(selected)`, the key every per-workspace store uses, so the diff tab and the Session pane read the same list without either resolving which repo a file is in. Holding needs no session. Only Send is gated, through `sendTargetFor`.
- **Memory only**, for the user's own comments. A relaunch drops them. A line range goes stale once the agent edits, so a persisted list would point at moved code.
- **One message.** `composeHunkComments` (`safeSend.ts:42`) sends a single comment bare, in the old `In @file lines a-b: text` form, and several numbered on one line, since a PTY send is collapsed to one line anyway. `hunkCommentsBlocks` gives a chat a fileRef plus text for each comment.
- **`submit` is the one send that makes a chat turn.** `SendToSession.submit` makes Terminal (`Terminal.tsx:1671`) hand the blocks to the chat tab as `CHAT_SUBMIT`, and ChatView answers the original request itself (`ChatView.tsx:1205`). It always `enqueue`s and lets the flush driver send: right away when idle, after the running turn otherwise, under the ceiling and parked checks the driver already has. It refuses an ended chat, an autopilot-locked one, one stopped at its ceiling, a parked queue, and a chat still loading, and toasts why. The PTY route ignores the flag, so a terminal still only gets the text placed.
- **Reviewer comments come from Rust.** On diff open, `DiffView` loads stored second opinion findings through `syncReviewed`, which replaces the reviewer entries and keeps the user's own. They keep their finding ids, so a reload never doubles one, and carry `author`, `session`, `target` (or `blocked` with the reason) and `stale`.
- **Send batches per target.** The user's own go to the selected session. A reviewer's go to the session it reviewed, through `requestSend`, which resumes a session that is not live, prefixed `X (second opinion):` by `attributed` (`safeSend.ts`). Sending writes `sent` back to Rust, Remove and Clear write `dismissed`.
- **Cleared only on `sent`, by id.** `HeldComments` drops exactly the entries it sent, so a comment held while the send was in flight survives it.

## Why it is this way

Queue rather than steer: a steer interrupts a turn the reviewer has not read yet. Enqueue even when idle: the flush driver is already the one place that knows when a chat may take a turn, and a second send path would have to repeat its checks.

## Related

- [[concept_safe_send]] the insert-only path, and the single exception `submit` makes to it
- [[concept_composer_queue]] where a submitted batch waits behind a running turn
- [[component_second_opinion]] the reviewer whose findings arrive as held comments
- [[gotcha_a_chat_opened_to_read_is_not_in_livechats]] why a read-only or closed chat never reaches the chat route
