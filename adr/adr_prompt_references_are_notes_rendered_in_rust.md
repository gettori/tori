---
summary: a prompt reference is one ref-* tori note per token, rendered and escaped only in Rust; TS sends typed ref blocks
status: current
updated: 2026-10-08
source: plan "Session, pull request, project and space references in the composer" (gettori/tickets#10, branch phase-1-block-1, commits 916622d3, b3feba30, 8f2f77cf); src-tauri/src/chat/model.rs:890,904
---

# Prompt references are notes rendered in Rust

## Context

A prompt needed to point an agent at a pull request, session, project or space without pasting it in. The agent reads the target through a `tori` tool, so the prompt carries only a token, a snapshot and which tool to use. Titles are text other people wrote and can contain anything, including `</tori>`. Two transports send prompts (stream-json and ACP), and three paths read them back (the live bubble, the ACP echo, replay).

## Decision

Each reference is a token in the sentence (`[PR 123]`, `[Session: title]`, `[Project: name]`, `[Space: name]`) plus one `<tori kind="ref-*">` note per token, placed before the user's text. The composer sends a typed `ref` block. Rust alone renders it (`ref_note`), escaping `<` and `>` in the JSON body, and reads it back (`ref_from_note`) beside the renderer. On `#`, Enter never resolves a number the open list lacks and Tab does, so "fixes #42" plus Enter still sends prose.

## Alternatives rejected

- **TS renders the note.** Two escapers, one per language, that must agree forever. The replay parser lives in Rust anyway.
- **Counter tokens with one trailing refs note.** A trailing note is not lifted (notes are only read from the start of a message), and one note for many refs breaks the one-token-one-target reading.
- **`FileRef`-like ref blocks on the wire.** No transport has such a block, so each would need its own rendering, and the agent would see nothing naming the tool.
- **`--add-dir` for another project's files.** Hands the chat a whole folder for one file. The one-time Read prompt is accepted instead.
- **Handing pi the transcript path as raw JSON.** pi has no `tori` server, so it gets files and PRs only.

## Consequences

A new reference kind is a `RefTarget` variant with `kind()` and `hint()` arms, a TS union member, and a chip action; every transport and reader picks it up. Ref notes must stay first in the message (`refs_first`), and the readers keep them in the user message rather than splitting them into Tori rows, unlike every other note kind.

## Related

- [[concept_prompt_references]]: the mechanism end to end
- [[concept_tori_notes]]: the note marker this reuses
- [[adr_attachments_are_labelled_paths]]: the attachment decision refs sit beside
- [[gotcha_a_tori_note_body_can_close_its_own_note]]: why the body is escaped
