---
summary: unchecking a Kobalte checkbox mounted on check inside a Dialog throws under jsdom 30, force mount the indicator instead
status: current
updated: 2026-08-25
source: Features phase 1 (#153), branch `feature-workspace`; `src/components/Checkbox/Checkbox.tsx:54`, `Checkbox.module.css`; `solid-presence@0.2.0 dist/index.js`, `jsdom@30.0.0`; commit c559862
---

# Unchecking a Kobalte checkbox inside a Dialog throws under jsdom 30

Do NOT put `Checkbox.Indicator` back on mount-on-check. Why: Kobalte mounts the tick through `solid-presence`, whose `getComputedStyle` memo runs when the ref is set, before the clone has left Solid's template document, and jsdom 30 resolves `animationName` lazily at the uncheck against a document with no `documentElement` (`Cannot read properties of null (reading 'firstElementChild')`, reported as an unhandled error). Outside a Dialog the same uncheck passes. `components/Checkbox` renders the indicator `forceMount` and hides it by CSS on `data-checked`, so the presence never flips.
