---
summary: a var fallback site renders fine even when the custom property is undefined, the value stays frozen ignoring data theme
status: current
updated: 2026-07-13
source: Central configurable UI system (personal/tori, branch code-mirror-6); `src/styles/tokens.css` (`--danger`/`--warn`/`--warn-strong`); commit 932f8ef
---

# var-fallback tokens silently hide un-themed values

Do NOT trust that a `var(--x, #hex)` site is theme-aware just because it renders correctly. Why: if `--x` was **never defined** anywhere, the fallback paints fine, so nothing looks broken, but the value is frozen and ignores `data-theme`. Several components shipped `var(--danger, #e06c75)` / `var(--warn, …)` for tokens no stylesheet defined; light mode left them dark with no error. Defining the tokens in `tokens.css` (dark value = the old fallback, so dark stays byte-identical; light value tuned) made **every** such site theme-aware at once with zero component edits. Audit for `var(--…, …)` whose custom property is undefined; each is invisible theming debt. See [[concept_design_token_system]] and [[lesson_measure_tokenization_before_css_migration]].
