---
summary: Vite 8's Oxc keeps JSX under tsconfig jsx preserve, so a .test.ts in the unit project that imports a .tsx module fails to parse
status: current
updated: 2026-10-06
source: plan "Tooling: one check everywhere, Vite+, formatters and linters", phase 2 (Vite 6 to 8), PR #257; src/components/Icon/agentMarks.test.tsx; vitest.config.ts
---

# Oxc honours jsx preserve, so a unit test importing .tsx fails to parse

Do NOT import a `.tsx` module from a `*.test.ts` file. Why: those run in the `unit` project, which has no Solid transform. Vite 6's esbuild compiled the JSX regardless of tsconfig's `jsx: "preserve"`, so it used to work; Vite 8 compiles with Oxc, which respects `preserve`, and the import fails with "Failed to parse source for import analysis". Name the test `*.test.tsx` so it lands in the `dom` project, as `agentMarks.test.tsx` now does.

## Related

- [[gotcha_vite_plugin_solid_forces_a_jsdom_test_environment]]
- [[adr_vite_plus_toolchain]]
