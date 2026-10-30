---
summary: a Vite worker is its own rolldown build, so a plugin only in plugins never sees its modules; list it in worker.plugins
status: current
updated: 2026-10-31
source: release-per-component plan, phase derived-inputs (commit d90b2678); vite.config.ts and mobile/vite.config.ts `worker.plugins`; scripts/bundled-inputs.ts
---

# A Vite worker is its own build, so a plugin misses its modules

Do NOT expect a plugin in `plugins` to see a worker's modules. Vite (vite-plus 1.3, on rolldown) builds each worker as a separate build with its own module graph, run inside the main one, so a plugin that collects module ids must also be in `worker.plugins` and keep its state in a map both instances share. Why: without it the syntax worker's `shikiEngine.ts` and its grammars never reached the desktop's input list, so a change there would not ship the app.

## Related

- [[concept_derived_release_inputs]] where it bit
- [[gotcha_vite_bundles_a_worker_only_where_new_worker_new_url_is_written]] the other worker trap
