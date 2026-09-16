---
summary: deleting an empty css module rule breaks a component indexing styles by variant, a missing key emits an undefined class
status: current
updated: 2026-07-13
source: Button component + migrate all buttons (personal/sway, branch code-mirror-6); `src/components/Button/Button.tsx` (`classList`), `Button.module.css` (`.default {}`, `.md {}`)
---

# CSS-Modules empty placeholder rules are load-bearing for dynamic classList keys

Do NOT delete an "empty" `.default {}` / `.md {}` rule from a CSS Module that a component indexes dynamically. Why: [[component_button]] applies its variant/size via `classList={{ [styles[variant ?? "default"]]: true, [styles[size ?? "md"]]: true }}`. If the rule for that key does not exist, `styles["default"]` is `undefined` and `classList` emits a literal `undefined` class. The rule can be **empty** (all the visual styling lives on the base `.btn` and the non-default variants), but it must exist so the CSS-Modules build emits a hashed name into the JS name-map. The CSS minifier strips the empty rule from the shipped stylesheet, yet the JS mapping survives (verified: `_md_1isji` present in the JS bundle though `.md {}` is gone from the CSS), so the class name is safe to reference. Every value a dynamic `styles[...]` lookup can take needs a declared selector, even a no-op one.
