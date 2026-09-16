---
summary: alpha and mix on a missing palette key return an rgba string with undefined channels, so a role renders wrong silently
status: current
updated: 2026-07-24
source: "Native theming system: palette + roles generator (personal/sway, branch `terminal-editor-design`); Phases 3, 7; `scripts/check-tokens.mjs`, `src/theme/admit.ts`; commit ad31d34"
---

# `buildRoles` fails as strings, not as exceptions

Do NOT wrap a role derivation in try/catch and assume a missing palette key will be caught. `alpha()` and `mix()` on an absent key produce `"rgba(undefined, undefined, undefined, 0.6)"` or `NaN` inside a template string, so `buildRoles` returns happily and CSS silently drops the declaration - the role just renders as whatever it inherited. Anything validating a palette must test the **value** for `undefined|NaN|var(`, which is the difference between the guard's palette probe passing and passing for the right reason. It is also why `admit()` runs structural validation *before* the contrast gate: otherwise one missing key reports as a hundred unmeasurable pairs.
