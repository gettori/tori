---
summary: adding a surface role without updating every foreground's on list leaves that pair unmeasured, not failing
status: current
updated: 2026-08-22
source: plan "Answer AskUserQuestion inside the chat panel" (phase 5), branch `chat-transcription`; `src/theme/contrast.ts`; `src/theme/roles.ts`; commit `6eb6e2b`
---

# A new surface leaves the text on it unmeasured

## What happened

A blocking tier was added so the permission prompt and the question card would stop being a gold hairline on the pane fill, and its `blocking.surface` lifted the card off `canvas.card` by a mix of the brand tint. The gate passed, all five palettes, first run. It was wrong: `fg.subtle` measured 2.74 on Sway Dark and `fg.muted` measured 4.42 on Rose Pine Dawn against the new surface, both under their floors, and the two cards are full of exactly that text (the hint, the preview, the Other label, the subagent badge).

## Why

[[concept_contrast_gate]] is **declaration driven**. `CONTRAST_RULES` measures a foreground against the surfaces its entry names, and `fg.muted` and `fg.subtle` named the four canvases. The moment their real background stopped being one of those, the pair stopped being measured, and an unmeasured pair reads in the output exactly like a passing one. Nothing was broken in the gate; it answered the question it was asked.

There is a second half. Once the pairs were declared, the amount became a **ceiling the palettes set** rather than a look to choose: every step off `card` moves the surface toward the text drawn on it, so the measured maximum is 0.04 dark and 0.07 light. The fill yields, not the hierarchy inside the card, because [[concept_contrast_gate]]'s `muted` tier is explicitly not a place to park a role that failed.

## What to do next time

**Adding a surface role is a two-part change: derive it, then find every foreground already drawn on what it replaced and add it to their `on` lists.** Grep the stylesheet for the rule you are restyling and list its `color:` declarations first; that list is the set of `CONTRAST_RULES` entries to touch. Doing it in the other order gives you a gate that passes and a theme that does not.

**Prove the gate bites before believing it.** Putting the bad amounts back failed 10 tests, in the bundled run and in the user-theme admission path. That is the evidence the declaration is doing work; a green run on its own is compatible with the pair never being looked at.

## Related

- [[concept_contrast_gate]] - the rule table and why the declaration is mandatory
- [[concept_design_token_system]] - the role set and the guard script
- [[lesson_measure_contrast_dont_look]] - the same argument one level up: the 2.5 to 3.0 band is invisible to the eye
- [[lesson_a_rule_that_matches_nothing_passes_every_guard]] - the general shape of a check answering a question nobody asked
