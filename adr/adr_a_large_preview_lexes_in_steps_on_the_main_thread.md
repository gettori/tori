---
summary: a large markdown preview lexes in marked's own two passes split into 8ms slices on main; a marked worker took 5.5s
status: current
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7, phase large-preview; `src/panels/Editor/previewBlocks.ts`, `src/panels/Editor/MarkdownPreview.tsx`; commit 2c6d0fee and the lex-in-steps commit after it
---

# A large preview lexes in steps on the main thread

## Context

Opening a 1 MB markdown file held one frame for over 400ms: about 90ms of `marked.lexer`, the parse and two `DOMParser` passes for sanitizing and images, and the layout of the whole document. The lexer cannot simply be cut into pieces, because reference links are resolved document wide.

## Decision

`lexInSteps` runs marked's own `lex()` taken apart at its seams: `Lexer.blockTokens` one chunk at a time (cut before a top-level heading after a blank line outside a fence, at least 16 KB), which collects every link definition, then the inline queue in batches of 64. The preview drives it inside the same 8ms slices that sanitize and mount blocks, sizing each slice from what the last one cost and shrinking when a frame comes late. Every top-level block gets `content-visibility: auto`. Measured: worst frame 46ms, whole document in 1.1s.

## Alternatives rejected

- **A marked worker.** It booted in 5ms and lexed 1 MB in 5,470ms in its own thread, against 90ms on main, so the preview sat blank for 5.5s. See [[gotcha_marked_lexes_sixty_times_slower_in_a_wkwebview_worker]].
- **Sending tokens back from a worker.** A 1 MB token tree is about 96k objects and costs around 200ms to clone on the receiving thread, which is the long frame again.
- **Rendering only the blocks near the viewport.** Find in page and the source to preview scroll handoff need the whole document in the DOM.
- **One pass on main, then slices.** One 90ms frame on every large open.

## Consequences

It leans on `Lexer.blockTokens`, `inlineQueue` and `inlineTokens` (marked 18.0.6), so a marked upgrade needs the equivalence rechecked against `marked.lexer`. A document with no headings is one chunk. Typing into a large open document restarts the stepped lex, so the preview updates on a pause. Blocks never seen are sized at a 3em guess until shown.

## Related

- [[component_markdown_preview]]: where it lives
- [[lesson_a_dropped_frame_belongs_to_whatever_ran_in_it]]: how the numbers were read
