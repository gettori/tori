---
summary: do not move marked into a Web Worker here: 1 MB lexed in 5,470ms in the worker against 90ms on the main thread
status: needs-verification
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7, phase large-preview, release runs 5 and 6 on 2026-10-05 (`preview-lex` and `preview-worker` trace notes)
---

# marked lexes about sixty times slower in a WKWebView worker

Do not move a regex-heavy JavaScript workload into a Web Worker in Tori's WebView without timing it inside the worker first: marked took 5,470ms there for a 1 MB document that lexes in 90ms on the main thread. Why: unknown. The worker booted in 5ms and the time was spent inside the lex itself, which looks more like code running without the JIT than a starved thread. Shiki's worker shows p50 1ms per small block, so it is not every task, but nobody has compared it with shiki on the main thread.

## Related

- [[adr_a_large_preview_lexes_in_steps_on_the_main_thread]]: what was built instead
- [[adr_chat_highlighting_runs_in_one_worker]]: the worker that stayed
