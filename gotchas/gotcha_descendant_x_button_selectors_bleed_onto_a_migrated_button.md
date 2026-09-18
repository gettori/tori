---
summary: a leftover descendant button selector at higher specificity overrides a migrated Button component's own class
status: current
updated: 2026-07-13
source: Button component + migrate all buttons (personal/tori, branch code-mirror-6); deleted `.termSearch button` (`Terminal.module.css`), `.reloadBanner button` (`CodeEditor.module.css`); see [[component_button]]
---

# Descendant `X button` selectors bleed onto a migrated `<Button>`

Do NOT migrate a bare `<button>` to `<Button>` without first checking for a **descendant** selector that styled it. Why: rules like `.termSearch button { … }` and `.reloadBanner button { … }` match *any* `<button>` inside the container, including the native `<button>` that `<Button>` renders. At specificity 0,1,1 they outrank Button's single-class `.btn`/variant rules (0,1,0), so the old styling wins and the migration appears to do nothing. Delete the descendant rule as part of the migration (its intent now lives in the Button variant). Related tiebreak: when two rules **tie** on specificity (e.g. a co-located `.toolbar :global(.btn)` override vs `.btn.sm`), the later one in the built CSS bundle wins, so verify actual byte order before assuming an override applies. Grep for `[.#][\w-]+ button` selectors before a button-unification pass.
