---
summary: the pre-commit vp check --fix wraps long generated values in tokens.css and check 2 compares byte for byte; keep prettier-ignore there
status: current
updated: 2026-11-17
source: plan "Visual polish pass with a Storybook kitchen sink" (personal/tori, branch ui-rework), phase 10 repair; scripts/gen-tokens.mjs:37; commit 2458ba2b
---

# The pre-commit format wraps the generated token region

Do NOT drop the `/* prettier-ignore */` line `scripts/gen-tokens.mjs` writes before each generated rule in `src/styles/tokens.css`. Why: the staged-file hook runs `vp check --fix`, which rewraps any value past 120 columns (a layered shadow stack is one), and the token guard's check 2 compares the generated region to the generator's output byte for byte, so the commit itself breaks the guard while every check run before it passed. Ignoring all of `tokens.css` in `vite.config.ts` was rejected because its primitives, spacing and type scale are hand-written; teaching the generator the formatter's wrapping would be a second definition of the format.

## Related

- [[gotcha_golden_files_are_compared_byte_for_byte_so_no_formatter_may_touch_them]]: the same collision on the Rust side, solved by the ignore list.
- [[concept_design_token_system]]: the generated tier this region holds.
