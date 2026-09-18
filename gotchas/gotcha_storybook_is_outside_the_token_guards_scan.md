---
summary: check tokens mjs walks src only, so a typo'd token name in storybook preview css paints nothing and fails silently
status: current
updated: 2026-08-12
source: "plan \"Storybook 10 workshop with a11y addon and theme toolbar\" (personal/tori, branch `96-storybook`, issue #96); `.storybook/preview.css`, `scripts/check-tokens.mjs:42`"
---

# `.storybook/` is outside the token guard's scan

`scripts/check-tokens.mjs` walks `src/` only, so `.storybook/preview.css` gets neither the color-literal check nor the "every `var(--x)` resolves" check. A typo'd token name there paints nothing and fails silently, which is the exact failure the guard exists to prevent and the same silent shape as [[gotcha_var_fallback_tokens_silently_hide_un_themed_values]]. Left as-is deliberately: it is a dev-only surface that never ships to users, and widening the guard's roots was out of scope for the ticket that created it. If `.storybook/` grows beyond the one small canvas sheet, widen `SRC` in the guard rather than trusting care. See [[component_storybook_workshop]].
