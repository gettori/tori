---
summary: a Kobalte slider's first render computes its thumb index from an unassigned ref and writes calc(NaN%)
status: current
updated: 2026-08-15
source: "plan \"Checkbox, Switch and Slider wrappers and control migration\" (personal/tori, branch `107-checkbox-switch-slider`, issue #107); `src/test/domSetup.ts:47`, `@kobalte/core@0.13.13 dist/chunk/WR5BIFYV.js`; commit 121f892"
---

# Kobalte's slider writes `calc(NaN%)` before its thumb ref lands

Do NOT mount a Kobalte slider in jsdom without the `setProperty` shim in `src/test/domSetup.ts`. The thumb derives its own index by matching its DOM ref against the registered thumbs, and on the first render that ref is unassigned, so the index is -1, `getThumbPercent(-1)` is NaN, and it writes `left: calc(NaN%)`. A browser drops the invalid declaration and the correct percentage lands a tick later, so nothing is visibly wrong; jsdom 30 parses values with css-tree in throwing mode, so the render dies instead, and the failure surfaces as a bare `SyntaxError: ")" is expected` with no mention of the slider. The shim answers it the way a browser does: drop what cannot be parsed. Scoped to `setProperty`, so a typo in one of our own CSS modules still fails loudly. See [[component_boolean_controls]].
