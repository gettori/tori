---
summary: chat attachments become labelled path mentions, never bytes, beating base64 blocks that bloated the transcript
status: current
updated: 2026-09-04
source: plan "Labelled path attachments in the chat composer" (personal/sway, branch `bugfix-260903`); probes run 2026-09-04 against claude 2.1.259
---

# Chat attachments are labelled paths, never bytes

A chat attachment of any kind (pasted, Finder-dropped, tree-dragged, `@`-mentioned) becomes a labelled path mention such as `[Image 3]: @/abs/path`, one `FileRef` per attachment, and the agent reads the file itself. Sway never puts image or document bytes on the wire even where the transport accepts them (a base64 `image` block and a `document` PDF block were both measured working over stream-json). Pasted bytes are written under app data first and the directory is passed with `--add-dir`, because Claude's Read outside the cwd prompts in default mode and the flag was measured to remove the prompt.

## Considered Options

- **Bytes on the wire** (what shipped for images first). Rejected: two wire shapes, every screenshot base64 in the transcript, replay either loses the image or holds a session's worth of them in memory, and the agent pays for an attachment whether or not it reads it.
- **Files under the workspace `.sway/`**. Rejected: a worktree can be deleted while the transcript that names the file lives on.

## Consequences

- The label form `[Kind n]: @path` is a transcript grammar Sway has to keep parsing, so it is pinned by a replay test and never changed silently. Case is not part of it: the kinds shipped lower case for a day, and every reader stays case-insensitive so those turns keep naming their attachments.
- A file's owners are the set of transcripts under every watched root, not one session: forks copy the conversation, moved chips cross tabs, and profiles have their own roots.
- What an agent can open is a per-transport tier in two keys, mentions and uploads, because ACP already carries a path as text but has no measured way to read app data.

## Related

- [[concept_safe_send]] - chips still wait in the composer; nothing here sends.
- [[adr_native_chat_surface]] - the transport-neutral event model this keeps.
- [[adr_credential_custody]] - the profile homes that make the transcript roots plural.
