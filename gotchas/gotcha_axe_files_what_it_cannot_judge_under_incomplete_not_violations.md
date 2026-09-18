---
summary: axe puts rules it cannot judge under jsdom into incomplete not violations, so violations only reports green falsely
status: current
updated: 2026-08-12
source: "plan \"axe-core harness in the jsdom vitest project\" (personal/tori, branch `97-axe-core`, issue #97); `src/test/axe.ts`, `src/test/axe.test.tsx:62`; commit 0010b81"
---

# axe files what it cannot judge under `incomplete`, not `violations`

Do NOT assert accessibility with `expect(results.violations).toHaveLength(0)` alone. `axe.run` returns four arrays, and rules it could neither pass nor fail land in `incomplete` (axe's own term: "review items"). Under jsdom that is the *common* case, not the edge case, because there is no paint and no layout: `<div aria-hidden="true"><button>x</button></div>` yields `aria-hidden-focus` in `incomplete` with `violations` empty, and `color-contrast` on any text lands there too. A `violations`-only assertion therefore reports green for every rule that silently did not run, which is indistinguishable from a clean component. `expectNoAxeViolations` in `src/test/axe.ts` fails on both arrays; a rule genuinely unjudgeable under jsdom is disabled by name with a reason instead. Why: "no violations" and "could not look" are the same observation from outside, and only one of them is good news.
