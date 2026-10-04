---
summary: every chat attachment becomes a token like Image 1 the sentence names, sent as a block the parser reads back exactly
status: current
updated: 2026-10-05
source: plan "Labelled path attachments in the chat composer" (personal/tori, branch `bugfix-260903`, commits `39ff592`, `51a8e81`, `be14911`), `src/utils/chatCompose.ts:117,211,432,452,468`, `src-tauri/src/chat/model.rs:798`, `src-tauri/src/chat/claude_transport.rs:377`, `src/panels/Chat/Composer.tsx`, `src/panels/Chat/MessageList.tsx`
---

# Labelled path attachments

Every attachment in a chat is a token the prose can name. Paste a screenshot, drop a PDF from Finder, drag a file out of the tree or complete an `@` mention, and the composer answers with `[Image 1]`, `[PDF 1]` or `[File 2]`: a chip in the strip and a token sitting in the sentence, so a user can write "compare [Image 1] with [Image 2]" and mean it. On the wire it is one labelled `FileRef` per attachment rendered as `[Image 1]: @/abs/path`, which is also the grammar a reopened chat reads back, so a replayed turn draws what the live one drew. The decision behind it is [[adr_attachments_are_labelled_paths]]; this page is the mechanism.

## How it works

**Kind by extension, never by MIME.** `attachmentKind(name, mediaType)` (`chatCompose.ts:117`) decides among `image`, `pdf` and `file` from the extension and consults the MIME only for a name that has none. Three kinds rather than a type per format, because the kinds are what an agent's Read can open, not what a file is. See [[gotcha_file_type_is_not_evidence_for_a_source_file]].

**Two sources, two capability keys.** A *mention* is a path the agent already has (tree drag, `@` completion); an *upload* is bytes Tori writes to disk first (paste, Finder drop). `checkAttachment` (`:141`) is given the source's kinds and refuses by naming what this agent can open. The kinds live per transport on the chat tier, in two keys, for the reason in [[concept_harness_capability_tiers]]. Uploaded bytes go to [[component_attachment_store]].

**Numbering is per tab and never reused.** `nextLabel(key, kind)` (`:432`) counts per `ComposerKey`, which is the tab id rather than the session id: a draft tab attaches before any session exists. `relabel(key, from, to)` (`:452`) is the single primitive every collision goes through, and it rewrites the chip, the draft text and any held auto-send text in one step, because the message being renamed may be the very one waiting to go out.

**A reopened chat raises its numbering before it can send.** `seedLabels(key, labels)` (`:468`) folds the labels a transcript already spent into the counters, relabels any chip that collides, and marks the key seeded. It runs inside the same `edit` that applies `chat_history`, and both send paths wait on `labelsSeeded`, holding through the existing `markAutoSend` route. Without the hold, a chip minted while history was still loading would put a number the transcript already holds on the wire twice. A queued message carries its labelled refs with it, and a queue restored from disk holds labels no transcript has seen yet, so its labels are folded in with `raiseLabels` (`seedLabels` without marking the key seeded) and sends wait on the queue load as well as the transcript, see [[concept_composer_queue]].

**The wire form is a text block, and the parse is its exact inverse.** `turn_frame` (`claude_transport.rs:377`) and `prompt_blocks` (`acp.rs:1038`) render a labelled ref as `[Image 1]: @/abs/path`. `ContentBlock::from_replayed_text` (`model.rs:798`) reads it back, and both replays use it: `history.rs` for the transcript claude writes, and `acp.rs`'s `UserMessageChunk` for the live channel an ACP agent replays over, which is the only place that transport can learn which labels are spent. The grammar is strict (a known kind, digits, then an absolute one line path) so a user who types `[Image 1]` in a sentence keeps their words, and the `#L2-4` tail is read back as a range rather than left buried inside a path. **Case is not part of it.** A label is minted capitalised (`Image`, `PDF`, `File`, matching how Claude Code spells its own) and read case-insensitively on every path, because the first day's transcripts spell the kinds in lower case and those turns still name real attachments. A replayed turn keeps its own spelling, since that is what its sentence says.

**The surfaces draw the same thing twice.** A chip is a container with two controls: the body inserts its token (click, or drag under the private MIME `application/x-tori-attachment-token`) and the remove button takes the attachment away, with `dropPending` (`:211`) stripping every occurrence of the token from the draft. The prompt bubble renders a token as a chip only when that turn actually carries a ref with the label, draws image kinds off the path through `convertFileSrc`, and appends the token of an attachment the sentence never named so nothing sends invisibly.

## Why it's this way

**A chip that is only a chip cannot be placed.** The old strip could hold an image but the sentence could not point at one, so two screenshots in one turn were "this" and "the other one". Putting the token in the text is what makes an attachment addressable, and it is why the chip body inserts rather than removes.

**The counters cannot live on the session.** [[adr_draft_first_chat]] means a tab attaches, types and queues a first message before a session id exists, so the numbering is keyed on the tab and travels with the chips when `seedForSend` moves them.

**The path in a transcript is somebody else's word.** The agent writes that file, so the parser asserts only that the path is absolute and on one line, and every surface still decides for itself what it will open: the bubble draws a thumbnail only when the path's own extension is an image kind.

**Nothing here sends.** Chips wait in the composer and the tokens are text the user can edit or delete, so [[concept_safe_send]] is untouched.

## Related

- [[adr_attachments_are_labelled_paths]] - the decision, its rejected options and its consequences
- [[component_attachment_store]] - where uploaded bytes live and how they are swept
- [[concept_composer_queue]]: queued entries that carry labels across a relaunch
- [[component_chat_panel]] - the composer strip and the prompt bubble that draw all this
- [[concept_harness_capability_tiers]] - why the kinds are two keys per transport
- [[concept_transport_neutral_event_model]] - the `ContentBlock` the label rides on
- [[concept_safe_send]] - the path this deliberately does not touch
- [[gotcha_file_type_is_not_evidence_for_a_source_file]] - why the kind is read off the extension
- [[gotcha_caretpositionfrompoint_does_not_exist_in_wkwebview]] - why a dragged token lands at the caret on macOS
- [[gotcha_an_asset_protocol_scope_cannot_see_a_dotted_directory]] - why the chip drew a broken image until the scope named the store
