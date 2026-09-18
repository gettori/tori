---
summary: every theme role must declare a contrast floor and surface, or the gate fails, catching 31 misses in shipped palettes
status: current
updated: 2026-08-22
source: "Native theming system: palette + roles generator (personal/tori, branch `terminal-editor-design`); Phases 6, 7; commit db3abe9"
---

# The contrast gate

**Location:** `src/theme/contrast.ts` (maths + the rule table), `src/theme/contrast.test.ts`, `src/theme/admit.ts` (the door it guards)

Structural validation cannot tell you whether a theme is readable. A palette can name every key, hold nothing but valid hex, and still be white on white. So legibility is **measured**, over every role, against the surface that role is actually drawn on, and a palette that misses is refused rather than painted. This is [[lesson_measure_contrast_dont_look]] made executable, and it is the gate [[component_theme_engine]]'s `admit()` runs before anything reaches the screen.

## Every role declares its floor and its surface, and the declaration is mandatory

`CONTRAST_RULES` carries one entry per role. An entry says the role is a foreground (`fg: { tier, on: [...] }`), or a surface (`surface: true`), or gives a `why` for being neither.

The mandatory part is the whole design:

- **A role with no entry is an error, not a skip.** A gate that quietly ignores what it was not told about passes on the day someone adds a role, which is the exact failure it exists to prevent.
- **An `on` naming a role not marked `surface: true` is also an error.** That is what makes "deleting a surface declaration fails the gate" true in *both* directions. Without it, removing a surface would silently drop every pair that referenced it, and a skipped measurement reads identically to a passing one in the output.

Two tests keep the table honest in both directions: the rule ids and the role ids must be exactly the same set.

## Three tiers, and the third is named as a trade-off

| Tier | Floor | What it covers |
|---|---|---|
| `text` | 4.5 | WCAG 2.1 AA body text |
| `graphic` | 3.0 | WCAG 1.4.11 non-text contrast, and 2.4.11 focus indicators |
| `muted` | 3.0 | Deliberately recessive text: `fg.subtle`, comments, punctuation, hints, inactive tabs |

`muted` is **not** a WCAG category and is documented as a design position, not disguised as one. Pushing those roles to 4.5 flattens the visual hierarchy the whole UI leans on. It is explicitly not a place to park a role that simply failed.

## A wash has no contrast of its own

A translucent value must be **composited onto its surface before measuring**. What a reader sees is the flattened result, so measuring the wash's own channels reports a colour that is never on screen. `parseColor` returns channels plus alpha, `composite` flattens, and only then does the ratio get computed. See [[gotcha_a_translucent_role_has_no_contrast_of_its_own]].

## Exemptions are principled, not convenient

- **`ansi.black` is exempt.** ANSI slots are used as fills as often as foregrounds (block drawing, `setab 0`), so slot 0 is the ramp's floor by definition; forcing it to 3:1 on a dark theme would render every standard palette wrong. **Slot 8 was not exempted** - it measured 2.90 and moved.
- **Shadows, scrims, borders, and scrollbar thumbs** carry a `why` rather than a floor: a `box-shadow` value is not a colour pair, and a hairline divider that cleared 3.0 would stop being a hairline.

## What it found, which is the argument for having it

The first honest run failed **both bundled palettes in 31 places**, in themes that had already shipped and looked fine. Most misses were 0.1 to 0.4 short. Two structural consequences:

- **`danger.emphasis` and `success.emphasis` had to exist.** One stop cannot be both readable *as text* on the canvas and dark enough to carry a white label: dark's `#2ea043` is 5.32 on the canvas and 3.37 under white. `attention` had carried that split for other reasons long before, which is what made the shape obvious once measured.
- **The focus ring was the widest miss and nobody had ever seen it**, at 2.52 dark and 1.70 light: a WCAG 2.4.11 indicator that only reads if you already know where focus is.

## Declaration-driven means a moved surface goes unmeasured

The mandatory entry catches a role with no rule. It does **not** catch a role whose rule is complete and whose surface has changed underneath it. `fg.muted` and `fg.subtle` named the four canvases; the moment the chat's blocking cards stopped painting `canvas.card` and started painting `blocking.surface`, every label on them was measured against a background it no longer had, and the run stayed green because an unmeasured pair and a passing pair look identical in the output.

The fix is the discipline rather than a check: **a new surface role is only half a change until every foreground already drawn on what it replaced names it too.** `blocking.surface` is now on the `on` list of `fg.default`, `fg.muted` and `fg.subtle`, and putting the original amounts back fails 10 tests across the bundled gate and `admit()`. See [[lesson_a_new_surface_leaves_its_text_unmeasured]].

## Watch out

- The gate reads **roles**, not palette primitives, so it cannot run before `roles.ts` has derived them. That is why validation is Rust and the gate is TypeScript, see [[component_theme_engine]].
- `checkPalette` takes its rule table as a **parameter**. A probe that mutates the exported table and restores it in a `finally` works until a test fails mid-way.
- Passing the gate is not the same as being *designed*. It refuses the unreadable; it has no opinion about the ugly.

## Related

- [[component_theme_engine]] - `admit()`, the two-stage door this is the second half of.
- [[concept_design_token_system]] - the role set being measured.
- [[lesson_measure_contrast_dont_look]] - why measuring beats looking, and the misses that proved it twice.
- [[adr_theme_palette_roles]] - the taxonomy the rule table is keyed by.
- [[lesson_a_new_surface_leaves_its_text_unmeasured]] - the failure mode above, measured.
