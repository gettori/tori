---
summary: the removed package guard matches raw text, so a banned package name in a comment fails the suite like an import
status: current
updated: 2026-11-21
source: "plan \"Checkbox, Switch and Slider wrappers and control migration\" (personal/tori, branch `107-checkbox-switch-slider`, issue #107); `src/lib/boundary.test.ts:47`; commit 121f892; src/lib/boundary.test.ts, gettori/tickets#106"
---

# The `src/lib` boundary guard reads comments, not just imports

Do NOT write a removed package's exact name (`@kobalte/core`, `lucide-solid`) in a comment, including in a test, anywhere under `src` or `mobile/src`. `boundary.test.ts` globs every source as raw text and asserts none contains the string, so a comment fails the suite exactly like a real import would. Why: a string match cannot tell prose from code, and the looser alternative is a guard that misses a dynamic import. Only the guard's own file is exempt. See [[component_lib_boundary]].
