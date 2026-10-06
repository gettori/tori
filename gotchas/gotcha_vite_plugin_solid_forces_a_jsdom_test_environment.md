---
summary: vite-plugin-solid injects a jsdom setup by default, add a standalone node environment vitest config for DOM free tests
status: current
updated: 2026-06-29
source: Overflow-tab-bar (personal/tori); `vitest.config.ts`, `src/components/tabOverflow.test.ts`
---

# vite-plugin-solid forces a jsdom test environment

Do NOT expect `vitest` to run pure (DOM-free) helper tests out of the box in this repo; add a standalone `vitest.config.ts` with `test.environment = "node"`. Why: `vitest` otherwise loads `vite.config.ts`, whose `vite-plugin-solid` injects a jsdom test setup, and the run dies with `Cannot find package 'jsdom'`. A dedicated `vitest.config.ts` takes precedence over `vite.config.ts`, skips the Solid plugin, and runs the node environment, enough for the `tabOverflow.ts` math tests.

## Related

- [[gotcha_oxc_honours_jsx_preserve_so_a_unit_test_importing_tsx_fails_to_parse]] why a unit test cannot import a .tsx module
