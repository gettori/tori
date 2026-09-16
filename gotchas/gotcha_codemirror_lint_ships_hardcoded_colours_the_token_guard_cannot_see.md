---
summary: check-tokens.mjs only scans src, so codemirror/lint's hardcoded colours render identical in both themes unseen
status: current
updated: 2026-07-20
source: Editor upgrades (personal/sway, phase 3); `src/App.css`, `src/styles/tokens.css` (`--diag-*`)
---

# CodeMirror lint ships hardcoded colours the token guard cannot see

Do NOT assume `scripts/check-tokens.mjs` protects you from unthemeable colour. It scans `src/`, so a dependency's base theme is invisible to it: `@codemirror/lint` hardcodes `#d11` and friends, which render identically in both themes — exactly the "light mode ships half-dark" failure the guard exists to prevent. Override the `.cm-lintRange-*` / `.cm-lint-marker-*` / `.cm-tooltip-lint` classes in `App.css` against tokens. The same applies to any CM6 addon with a base theme.
