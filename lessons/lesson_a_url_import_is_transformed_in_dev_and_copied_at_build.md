---
summary: serving a worker via `?url` breaks only in dev since Vite injects a document touching import, serve it as a plain asset
status: current
updated: 2026-09-07
source: plan "PDF viewer tab" (personal/sway, branch `logo-update-260907`), phase 1 . `vite.config.ts`, `src/panels/Editor/pdfjsRuntime.ts` . commit `bfb58fd`
---

# Serve a worker script as an asset, never through `?url`

## What happened

pdf.js's worker was named with `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`. The release build was fine. The dev build reported the fake worker on every PDF, meaning every page was being rasterised on the main thread with the window frozen, and nothing said so except the one warning that had been added on a hunch.

## Why

Vite's dev server runs a `?url` target through its transform pipeline and prepends `import { injectQuery as __vite__injectQuery } from "/@vite/client"` to it. That module touches `document`. A worker has no `document`, so the module worker throws while loading, and pdf.js answers a worker that will not load by silently parsing on the main thread instead. Rollup emits the same file verbatim at build, so release never had the problem.

The worker bundle has no static imports and no `new URL(..., import.meta.url)` in it, so the transform had nothing legitimate to do to that file. It only did damage.

The real defect was not the broken worker. It was that **dev and release disagreed about the exact thing the check existed to answer**, which is the failure mode that survives a whole feature: it works when you test it and it is broken when the user runs it, or the reverse, and either way the check is worthless. Serving the worker beside the cmap and wasm data through the same plugin makes the two builds emit byte-identical files at the same path, with no `?url` import left anywhere.

A second thing hid it. `import.meta.env.DEV` is false in a release build, so a DEV-gated "worker is real" info log cannot answer the question at all. The check had to become a warning that fires in **every** build only on the bad path, so that silence is the passing signal.

## What to do next time

- **Do not use `?url` for anything a worker will load.** Serve it as an asset, from a plugin or `public/`, so dev and build hand out the same bytes. This applies to any module worker, not just pdf.js's.
- **When a library degrades silently, make the degradation loud in every build.** A `DEV`-gated log answers a question about dev only. If the claim is "this is true in the shipped app", the check has to run in the shipped app, and its passing state should be silence rather than a line you have to remember to look for.
- **Before trusting a dev-build observation, ask whether the bundler treats that file differently at build.** `?url`, `?raw`, `?worker` and `new URL(..., import.meta.url)` all have a dev path and a build path, and they are not the same path.
- **Diagnose by fetching the served bytes.** The cause was found by starting the dev server and requesting the module, not by reading Vite's source. One `curl`-equivalent showed the injected import at the top of the file.

## Related

- [[concept_pdfjs_in_the_webview]] - the plugin that serves the worker now, and the rest of what pdf.js fetches at runtime.
- [[component_pdf_viewer]] - the feature this was blocking.
- [[lesson_a_gate_only_sees_the_configuration_the_test_builds]] - the same shape: a check that cannot see the configuration it claims to cover.
