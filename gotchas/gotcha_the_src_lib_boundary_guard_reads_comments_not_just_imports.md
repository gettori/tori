---
summary: the src lib boundary guard matches raw text, so naming Kobalte in a comment fails the suite exactly like a real import
status: current
updated: 2026-08-15
source: "plan \"Checkbox, Switch and Slider wrappers and control migration\" (personal/sway, branch `107-checkbox-switch-slider`, issue #107); `src/lib/boundary.test.ts:47`; commit 121f892"
---

# The `src/lib` boundary guard reads comments, not just imports

Do NOT write `@kobalte/core` in a comment outside `src/lib/`, including in a test. `boundary.test.ts` globs every source as raw text and asserts none *contains* the string, so a comment explaining which version a behaviour was verified against fails the suite exactly like a real import would. This is the guard working as designed (a string match cannot tell prose from code, and the looser alternative is a guard that misses a dynamic import), so the fix is to write "Kobalte" or "the installed 0.13.13" instead. See [[component_lib_boundary]].
