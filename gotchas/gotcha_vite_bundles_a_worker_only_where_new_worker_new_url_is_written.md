---
summary: pass a worker to a helper as a factory, never a URL: Vite only bundles new Worker(new URL(...)) written at the call site
status: current
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7; `src/utils/startWorker.ts`, `src/panels/Chat/highlight.ts`; commit 2c6d0fee
---

# Vite only bundles a worker where `new Worker(new URL(...))` is written

Do not hand a shared helper a `URL` and let it call `new Worker(url)`: Vite finds and bundles a worker only from the literal `new Worker(new URL("./x.ts", import.meta.url), ...)` expression, so pass `() => new Worker(new URL(...), { type: "module" })` instead, as `startWorker` takes it. Why: the detection is a static pattern match at the call site, and a URL built elsewhere ships unbundled. Workers that load grammars by dynamic import also need `worker.format: "es"` in `vite.config.ts`, since an iife worker cannot split chunks.

## Related

- [[component_chat_highlighter]]: the helper that takes a factory
- [[lesson_a_url_import_is_transformed_in_dev_and_copied_at_build]]: the other worker serving trap
