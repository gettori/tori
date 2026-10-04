---
summary: createHighlight answers chat code colours from the shiki worker with a per block queue, a char bounded cache, a fallback
status: current
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7; `src/panels/Chat/highlight.ts`, `src/panels/Chat/highlightQueue.ts`, `src/panels/Chat/shikiWorker.ts`, `src/utils/startWorker.ts`, `src/panels/Chat/escapeHtml.ts`; commits 47f207dd, 2c6d0fee
---

# Chat highlighter

`src/panels/Chat/highlight.ts` is the eager face of chat syntax highlighting; shiki itself runs in `shikiWorker.ts`.

## Responsibility

- `createHighlight()` gives a component `{ html, lines }`, each taking code, a language and an optional slot, so one component can own several blocks (a diff's hunk sides). Null over `HIGHLIGHT_MAX`, for a language with no grammar, for a slot whose grammar failed, and before the first answer.
- `highlightQueue.ts` is pure: one request in flight per slot and at most one waiting, a newer request replaces the waiting one, and a reply is delivered even when a newer request waits, because its text is a prefix of what the block now shows.
- The cache keys on form, language and the code itself, bounded by characters of key plus answer (4M).
- `startWorker` (in `src/utils`) owns start, the `ready` handshake, the 10s timeout and the single fallback. A missing `Worker` (tests) goes to the main-thread engine silently.
- `takeHighlightTimes()` hands the trace recipe the worker's time per block.

It does not own the `<pre><code>` frame, the theme, or the language guess from a path beyond `langOfPath`.

## Interface

Callers: `CodeBlock`, `ToolBody`'s `Highlighted`, `CodeLines` and `DiffView`. The worker answers `{ id, value | none | error, ms }`.

## Related

- [[adr_chat_highlighting_runs_in_one_worker]]: why it is shaped this way
- [[gotcha_vite_bundles_a_worker_only_where_new_worker_new_url_is_written]]: why `startWorker` takes a factory
- [[component_chat_panel]]: the transcript it paints
