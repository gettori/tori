---
summary: session_issues.json keeps the issues each chat read or was sent, with their repo; it feeds Cmd+K numbers and the Link chip
status: current
updated: 2026-11-20
source: "plan \"Cmd+K navigator\" (personal/tori, branch `cmdk-improvements`), Phase 8, commit `1bcfa5f1`; `src-tauri/src/session_issues.rs`, `src-tauri/src/rpc/methods.rs:534`, `src-tauri/src/chat/commands.rs:596`, `src/utils/sessionIssues.ts`, `src/utils/mentionLink.ts`, `src/panels/Chat/LaneStrip.tsx`"
---

# Session issues

`src-tauri/src/session_issues.rs` records which issues a chat touched, so a
person can find the chat by that number and link the issue to the chat's
worktree or Topic in one click.

## Responsibility

- **Capture, in Rust only.** `note_read` (`rpc/methods.rs:534`) records an
  issue a chat reads through `issues.get`, only for
  `Principal::Session(Caller::Chat(id))`, qualified with the project's origin.
  `chat_send`, `chat_send_held` and `chat_steer` go through
  `deliver_noting_issues` (`chat/commands.rs:596`), which reads issue URLs out
  of text blocks and records them only after the send succeeded. A change emits
  `mentions://changed`. A PR URL or bare `#N` text is not a mention.
- **Storage.** `session_issues.json`, `{session: [{owner, repo, number}]}`,
  oldest first, the newest 20 per session (`CAP`), written atomically under a
  cross-process lock, modelled on `session_links.rs`. A repeat mention writes
  nothing. `forget` runs when a session is deleted.
- **It never links anything.** Only a person turns a mention into a link;
  agents never attach an issue ([[component_issue_source]]).

## Interface

- `session_issues_list` returns the whole map; `src/utils/sessionIssues.ts`
  holds it in a signal, read at start and on each `mentions://changed`.
- [[component_nav_index]] gives chats and sessions their mentions, and the
  ranker scores a mention below a linked issue, a PR and a branch number
  ([[concept_navigator_ranking]]). The row's subtitle reads "mentions
  tickets#92".
- `linkOffer(session, workspace)` in `mentionLink.ts` offers the newest mention
  not dismissed when the chat's unit or Topic has no issue yet (never for a
  Home chat). `LaneStrip` draws it as a "Mentioned" group, "Link #92", with a
  dismiss button. Dismissals live in localStorage `tori.mentionsDismissed` per
  session and key. The click runs `issues_get` (the store keeps no title or
  URL), then `issues_record` or `set_topic_issue`.

## Related

- [[component_issue_source]] where the link lands, and repo plus number identity
- [[component_command_palette]] the box that finds a chat by a mentioned number
