---
summary: a role token reads correct regardless of import order since inline html props outrank the token layer, check by swap
status: current
updated: 2026-08-12
source: "plan \"Storybook 10 workshop with a11y addon and theme toolbar\" (personal/tori, branch `96-storybook`, issue #96); `.storybook/preview.tsx`, `src/App.tsx:52`"
---

# A role value cannot prove the CSS import order is right

Do NOT verify a global-stylesheet import order by spot-checking a role token. Why: [[concept_design_token_system]] paints role cssVars as **inline props on `<html>`**, and inline props outrank every rule in the token layer, so `--canvas-default` and `--fg-default` read correct no matter which order the sheets were imported in. The order still matters: `App.css` is deliberately un-layered, so it must come **last** to sit above `@layer`, and getting it wrong makes those rules lose instead of win while every role value still spot-checks green. The check has to look at something the cascade actually decides. Test by **inversion**: build twice, once with the order swapped, and diff the emitted CSS. Swapping `App.css` above `tokens.css` moved `.seti-icon` from byte 16394 to byte 192, ahead of the token layer, and changed the bundle's content hash, which is a check that can fail. Same shape as [[lesson_a_gate_that_cannot_fail_is_not_a_gate]]. See [[component_storybook_workshop]].
