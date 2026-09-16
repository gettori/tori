---
summary: vitest's node environment resolves solid-js to its server build, importing lucide-solid throws a client only API error
status: current
updated: 2026-07-31
source: Space icons & reordering (personal/sway, branch code-mirror-6); `vitest.config.ts` (inline + conditions), `src/components/Icon/iconRegistry.test.ts`; commit 68920f0; see [[component_project_discovery]]
---

# vitest's node env gives solid-js its server build

A `.test.ts` that imports **any** `lucide-solid`/solid component throws `Client-only API called on the server side` at **import time** (before a single assertion). Why: `vitest.config.ts` runs `environment: "node"` with the deps externalized, so Node's own resolver picks solid-js's `web/dist/server.js` via the `node` export condition, and lucide-solid's `Icon` module calls a client-only API at module load. Vite's `resolve.conditions` alone does **not** fix it, externalized `node_modules` bypass Vite's resolver. The fix is two-part in `vitest.config.ts`: **inline** the packages (`test.server.deps.inline: ["solid-js", "lucide-solid"]`) so Vite transforms them, **and** set `resolve.conditions`/`ssr.resolve.conditions` to `["browser", "development"]` so the browser build is chosen. No jsdom is needed, the test only *imports* the components (e.g. the icon registry's `resolveIcon`), never renders them. Symptom to recognize: a brand-new DOM-free `.test.ts` fails as a whole "Failed Suite" with a solid `notSup`/server-side stack, not an assertion error.

**Extended 2026-07-31:** `deps.inline` needs **patterns, not bare names**. `["solid-js"]` inlines `solid-js` but leaves `solid-js/web` externalized, so `<Portal>` is created by a *second* Solid instance that the render root's `dispose()` does not own - a portalled panel then survives `cleanup` into the next test, which is exactly what `src/test/domSetup.ts` exists to prevent. Symptom: tests counting rows see the previous test's. Use `[/solid-js/, /lucide-solid/]`. Fixing it also surfaces `scrollTo is not a function` errors the split instance had been swallowing; jsdom implements neither scroll method, so both are stubbed centrally. **Source:** Session navigation moves to a History dropdown (branch `navigation`, phase 5) · `vitest.config.ts` · commit 766fc28
