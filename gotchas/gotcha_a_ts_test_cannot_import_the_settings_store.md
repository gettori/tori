---
summary: a .ts test runs in node, so importing anything that reaches settingsStore throws localStorage is not defined; split the pure part
status: current
updated: 2026-11-20
source: "plan \"Cmd+K navigator\" (personal/tori, branch `cmdk-improvements`), Phase 12, commit `6cef3f21`; `vitest.config.ts:60`, `src/utils/usageRows.ts`, `src/utils/usageSettings.ts`"
---

# A .ts test cannot import the settings store

Do NOT give a pure helper an import that reaches `settingsStore`, directly or through something like `agentEnabled`, if its test is a `.ts` file. `vitest.config.ts` runs `*.test.ts` in the node environment and `*.test.tsx` in jsdom, and the store touches `localStorage` at import, so the test fails with "localStorage is not defined" before a case runs. Move the pure code into its own module with only type imports from the store side, as `usageRows.ts` (`usageSummary`, `tightestWindow`) was split from `usageSettings.ts` (`usageAccounts`). Why: the environment is chosen by the file extension, not by what the test needs.

## Related

- [[gotcha_vitests_node_env_gives_solid_js_its_server_build]] the other trap of the node environment
