---
summary: a string like #123 reads as a hex colour to check tokens mjs, so pass the number and let the component print the ref
status: current
updated: 2026-09-24
source: "plan \"Autopilot design (#201)\" (personal/tori, branch `orchestrator`); commit 821fbf48; `scripts/check-tokens.mjs`, `src/components/Autopilot/DecisionCard.tsx`"
---

# `check-tokens.mjs` reads an issue ref as a hex colour

Do NOT write a ticket or PR ref such as `"#123"` or `"#131"` as a literal in a `.ts`/`.tsx` file under `src/`, stories and fixtures included. Three or six hex digits after a `#` is a colour to the scan, so it fails the suite with "color literal outside the token layer". Take the number as a prop and build the text in the component (`DecisionCard`'s `refNumber`, `PrLine`'s `number`), or build fixture text with a helper such as `ref(123)`. Why: the scan matches the shape of a hex colour and cannot tell an issue number from one.

## Related

- [[gotcha_check_tokens_mjs_reads_an_html_numeric_entity_as_a_hex_colour]]: the same scan, the same false positive, another source
- [[gotcha_check_tokens_mjs_reads_a_colour_word_in_a_test_name_as_a_colour_literal]]
- [[component_autopilot_parts]]
