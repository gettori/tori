---
summary: chat shiki runs in one module worker; a pending block shows its old colours plus the new text plain, never flickers
status: current
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7, phase shiki-worker; `src/panels/Chat/highlight.ts`, `src/panels/Chat/highlightQueue.ts`, `src/panels/Chat/shikiWorker.ts`; commit 47f207dd
---

# Chat highlighting runs in one worker

## Context

Shiki ran on the main thread, and `Markdown.tsx` settles once per frame while an answer streams, so the tail code block re-highlighted its whole text every frame. Moving the work to a worker makes the answer asynchronous, and a sync lookup keyed by content then answers null for every new frame of a streaming block.

## Decision

One lazily started module worker runs `shikiEngine`. Each block reads through `createHighlight()`, which keeps one request in flight and one waiting per block, and while a request is out renders the last answer's HTML followed by the newly appended text, escaped and plain. Results are cached by form, language and code, bounded by characters. A worker that cannot be built, sends no `ready` within 10s, or fails its own init falls back to the main-thread engine and warns in every build; a grammar error leaves only that block plain.

## Alternatives rejected

- **A pool of workers.** Shiki tokenizes one request at a time, and each worker would load every grammar again.
- **Shutting the worker down after 30s idle.** A restart reloads every grammar mid session.
- **Showing the last HTML alone while waiting.** The text lags behind the stream by a round trip.
- **Plain until the matching answer lands.** A streaming block flickers between plain and colour every frame.
- **Highlighting in Rust (syntect or tree-sitter).** A second grammar set with different colours, and the scope mapping in `shikiEngine.ts` would need a port.

## Consequences

Callers use the per block primitive rather than a sync function, so a block that renders code must be a component that owns one. The worker needs no theme sync, because the highlight HTML only names `var(--syntax-*)`. Measured in the release app: p50 1ms per block in the worker, worst 739ms for the first block (startup and grammar load).

## Related

- [[component_chat_highlighter]]: the modules this decision produced
- [[gotcha_vite_bundles_a_worker_only_where_new_worker_new_url_is_written]]: why the worker is created through a factory
- [[lesson_a_url_import_is_transformed_in_dev_and_copied_at_build]]: the dev and release check the worker passed
