---
summary: check tokens mjs matches the hex digit run in an html numeric entity and reports a colour literal, failing the suite
status: current
updated: 2026-08-16
source: "plan \"Tab and OverflowTabBar onto Kobalte Tabs\" (personal/sway, branch `111-tab-and-overflow-tab-bar`, issue #111); `src/components/Tab/Tab.test.tsx`, `scripts/check-tokens.mjs`"
---

# `check-tokens.mjs` reads an HTML numeric entity as a hex colour

Do NOT write a numeric character reference such as `&#9679;` in a `.ts`/`.tsx` file under `src/`. The colour-literal scan in `scripts/check-tokens.mjs` matches on the hex-digit run and reports it as "1 color literal(s) outside the token layer", pointing at a line with no colour in it. `pnpm test` runs the check before vitest, so the whole suite refuses to start over a bullet glyph. Write the character itself (the codebase already does, e.g. the dirty dot in `Editor.tsx`), or pick different content. Worth knowing because the error names a real rule and a real file, so the first instinct is to go looking for a colour.
