---
summary: attachment store writes pasted or dropped files under ~/.config/sway/attachments as raw bytes, not base64 JSON
status: current
updated: 2026-09-04
source: not recorded; imported from grimoire docs/personal/sway; `src-tauri/src/attachments.rs`, `src-tauri/src/sessions.rs:870`, `src/panels/Chat/composerAttachments.ts`
---

# Attachment store

**Location:** `src-tauri/src/attachments.rs` (commands `store_attachment`, `attachments_dir`), swept from `src-tauri/src/sessions.rs:870` (`delete_session`), reached from `src/panels/Chat/composerAttachments.ts`

Where a pasted or dropped chat attachment goes so that it can be a path instead of bytes on the wire. One command writes the file and answers with its absolute path, another names the directory so it can ride `--add-dir` at spawn time, and a sweep on session delete removes what no transcript still names. See [[concept_labelled_attachments]] for what the path then becomes.

## Responsibilities

- Write bytes handed over from the composer and answer with an absolute path (`store_attachment:26`).
- Name the directory before any attachment exists, so `ChatView` can pass it in `extraDirs` at spawn (`attachments_dir:19`).
- Decide nothing about kinds, sizes or labels: the composer refuses a file before it ever reaches here.
- Remove what a deleted session attached, and only what no other transcript still names (`holders_named_by:75`, `drop_unreferenced:91`).

## Key files and entry points

- `dir():14` - `~/.config/sway/attachments`, beside icons and agents rather than under Tauri's app data, because every other Sway store already lives there. Never under a workspace: a worktree can be deleted while the transcript naming the file lives on.
- `store_attachment:26` - takes the file as a raw body (`tauri::ipc::Request`, `InvokeBody::Raw`) with the filename percent encoded in an `x-sway-attachment-name` header. A 32MB PDF as base64 in JSON would be a 40MB string parsed twice on the way in.
- `store_in:46` - writes `<id>/<safe name>`, where the id (nanos plus an atomic counter, no uuid crate in the tree) is a **directory** rather than a prefix on the name. Two pastes of `shot.png` stay apart while the file keeps the name the user gave it, which is the name the chip shows and the name the agent reads in the path.
- `safe_name:58` - last path component only, control characters dropped, capped at 120 characters, falling back to `attachment`. A name says what a file is, never where it goes.
- `holders_named_by:75` / `drop_unreferenced:91` - the delete sweep, below.

## The delete sweep

`delete_session` reads what the transcript named *before* removing it, then sweeps after, so the file being deleted is not counted as a reference to itself. The sweep runs outside the `sessions-store` lock, since it can read a lot and the store is already done with.

- **The question is "which stored file does this text name", never "which paths does this text contain".** The candidates are the holder directories under the attachments dir, matched as a fixed byte string of holder path plus separator. The holder id is Sway's own and always plain, so a filename carrying a quote or a backslash cannot slip past JSON escaping, and the trailing separator stops `<id>/` matching `<id>0/`.
- **A file lives while any transcript under any `watch_dirs()` root names it.** A fork copies the conversation and a moved chip crosses tabs, so the owner of an attachment is a set of transcripts, not one session. Profile homes are separate roots and count the same ([[adr_credential_custody]]).
- **Anything unreadable keeps everything.** An unreadable transcript, project folder or root stops the sweep and deletes nothing. A directory that does not exist is a different answer and names no file, so a configured but empty profile home does not freeze the sweep forever.
- **The whole holder goes**, not just the file, since storage is a directory per attachment.

## Known limits

- The walk is `<root>/<project>/<file>`, the layout the session index already reads these roots by. An adapter nesting deeper would have its references missed, and a missed reference deletes.
- An ACP conversation lives with its agent and Sway keeps only a locator, so a chip moved into an ACP tab and sent is a reference nothing can scan.
- When the deleted session had attachments, every transcript under every root is read whole. Guarded (no attachments, no walk) and it stops as soon as every candidate is claimed.

## Drawing what is stored

A chip and a prompt bubble draw the file through the asset protocol, which is a
second permission entirely: `security.assetProtocol.scope` in `tauri.conf.json`
had to name `$HOME/.config/sway/**` before anything here could be shown, because
a bare `**` does not match a path component that starts with a dot. See
[[gotcha_an_asset_protocol_scope_cannot_see_a_dotted_directory]].

## Related

- [[concept_labelled_attachments]] - what the returned path becomes in the composer and on the wire
- [[adr_attachments_are_labelled_paths]] - why paths and not bytes, and why not the workspace `.sway/`
- [[component_chat_host]] - where `extraDirs` becomes `--add-dir` on the spawn
- [[adr_credential_custody]] - why the transcript roots are plural
- [[component_session_scanner]] - the same root walk, read for a different question
