---
summary: a chat is the folder chats/<id> plus every session whose cwd is in it, selected as kind chat keyed chat:<id>
status: current
updated: 2026-11-03
source: Global space ticket (branch global-space), phase chats-and-artifacts; commit 00e2db13; src-tauri/src/chats.rs:68; src/utils/chats.ts:43
---

# Chats

A chat is a conversation with no project. Its identity is a folder Tori owns, `config_dir()/chats/<id>`, and every session spawned with that folder as cwd belongs to it: the first send, and the forks, rewinds and handoffs that keep the cwd. The row shows the newest session's name.

## How it works

- **Make.** `chat_new` mints the id and creates the folder; the sidebar holds the chat in memory (`fresh`) until a session shows up in the listing, then selects it and opens a draft there through `DRAFT_INTO_NEW`. The draft stays a draft until first send ([[adr_draft_first_chat]]).
- **List.** The session store tracks the chats root with `inclusive: true`, and a targeted `sessions://changed` naming a folder under it refreshes it. `groupChats` (`src/utils/chats.ts:43`) groups rows by the first path segment under the root; `chats` reuses an unchanged `Chat` object so a keyed `For` does not remount a row on refresh.
- **Select.** `Selection.kind: "chat"` with `chatId` and `folderPath` = the folder. `workspaceKey` answers `chat:<id>`; `selectionRoot`, `chatRoot`, the watcher and the one-pane seed needed no change. The selection carries the newest session (or the one a tab or notification named) so session-following panels work.
- **Delete.** The sidebar tears each session down the way a single delete does (`chat_close`, delete the transcript, prune checkpoints and hook status), then `chat_delete` (`src-tauri/src/chats.rs:68`) removes the folder and `purgeWorkspace("chat:<id>")` clears per-workspace stores.
- **Artifacts.** `chat_artifacts(chatId, transcripts)` lists the folder recursively (dot entries and symlinks skipped, capped) as made, and the attachment holders the given transcripts name as added. The panel re-lists on `fs://changed` for the chat root and when a session's stamp moves, since attachments live outside the watched folder.

## Why it is this way

- A folder per chat rather than per session: a rewind or fork spawns a new session id, and a per-session folder would hide the files the earlier session made.
- Session teardown stays on the frontend because deleting sessions from Rust would touch the real session stores in tests.
- A chat made and never sent to leaves an empty folder behind; nothing lists it after a relaunch.

## Related

- [[concept_folder_anchored_sessions]] - sessions are anchored by cwd, which is what makes the folder the chat
- [[adr_draft_first_chat]] - the draft before first send
- [[adr_global_is_a_separate_resolved_field]] - Global, where chats are listed
- [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]] - why `chats` reuses objects
