---
summary: a test dispatching window events must be named test.tsx, the .test.ts project runs in node with no window
status: current
updated: 2026-09-07
source: plan "Chat composer Tier 1" (personal/tori, branch `composer-260907`), phase 4 . `vitest.config.ts:65` . `src/panels/Chat/composerScratch.test.tsx` . commit `8e8579e` . _2026-09-07_
---

# A test that dispatches window events cannot be a `.test.ts`

Do NOT give a module test the `.ts` extension when it emits or listens on `window`. Why: the two vitest projects split on extension (`*.test.ts` is the node environment, `*.test.tsx` is jsdom), so a `.ts` file testing an event-bus round trip fails on `window is not defined` even though the module under test has no DOM in it. Rename to `.tsx`; nothing else changes.
