---
summary: npm test runs check-tokens.mjs before vitest, a bare npx vitest run skips the only guard for dead var names or colours
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Tori's own commands as tabs in a Shells workspace\" (personal/tori, branch `standalone-terminals`, issue #166), Phase 5; `package.json` (`test`), `scripts/check-tokens.mjs`; commit `d4a59d3`"
---

# `npm test` is `check-tokens` plus vitest, so `npx vitest run` skips a whole guard

Verify with `npm test`, not a bare `npx vitest run`: the script is `node scripts/check-tokens.mjs && vitest run`, and that guard is the **only** thing in the repo that catches a `var()` naming a property nothing declares, a colour literal outside `tokens.css`, or a palette missing a role. Two dead token names shipped in `cce6db6` because that phase was verified with the bare vitest call, and the phase after it repeated the mistake.
