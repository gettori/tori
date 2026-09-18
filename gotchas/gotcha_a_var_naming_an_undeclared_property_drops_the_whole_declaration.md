---
summary: a var referencing an undeclared custom property with no fallback drops the whole CSS declaration silently
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Tori's own commands as tabs in a Shells workspace\" (personal/tori, branch `standalone-terminals`, issue #166), Phase 5 (fixing Phase 3); `src/panels/LeftSidebar/LeftSidebar.module.css:818`; commit `d4a59d3`"
---

# A `var()` naming an undeclared property drops the whole declaration

Do NOT read a rendered element as proof its custom properties resolve: a `var(--x)` with **no fallback** whose property nothing declares makes the browser drop that declaration entirely, so the element silently inherits and nothing reports it. `.shellsState[data-state="failed"] { color: var(--danger-default) }` left every failed command in the Shells list looking exactly like a running one, while the DOM assertion on `data-state="failed"` passed. The fallback form fails differently, see [[gotcha_var_fallback_tokens_silently_hide_un_themed_values]].
