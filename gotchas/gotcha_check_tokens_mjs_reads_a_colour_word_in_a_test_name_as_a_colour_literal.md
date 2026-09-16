---
summary: the token guard scans src for colour literals without excluding test titles, so a test named turns red fails the build
status: current
updated: 2026-09-07
source: plan "Chat composer Tier 1" (personal/sway, branch `composer-260907`), phase 3 . `scripts/check-tokens.mjs` . `src/panels/Chat/Composer.test.tsx` . commit `c3eb12f` . _2026-09-07_
---

# `check-tokens.mjs` reads a colour word in a test name as a colour literal

Do NOT name a test "turns red" (or any CSS colour word). Why: the token guard scans `src/` for colour literals without excluding test titles, so the string in an `it(...)` fails the build with a report that points at the test line and says nothing about naming. Rename the assertion ("is marked missing") rather than adding an allowlist entry.
