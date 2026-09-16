---
summary: contrast misses between 2.5 and 3.0 look fine to the eye and fail a ratio, so measure every role as a mandatory gate
status: current
updated: 2026-07-24
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/sway, branch `topbar`); Phase 3; `src/styles/tokens.css`; confirmed again: Native theming system: palette + roles generator (branch `terminal-editor-design`) Phase 6, commit db3abe9"
---

# Contrast misses are invisible to the eye and obvious to a ratio

## What happened

Shipping light mode meant auditing it. Rather than looking at the UI, every foreground/background token pair in both themes was measured (WCAG ratios with alpha compositing, 3.0 floor for graphic elements, 4.5 for body text). Two real defects surfaced that no amount of looking had caught:

1. **The light brand ramp.** `--brand` started at gold-600, which measured **2.95** against `--pane-head-bg` and **2.76** against `--sel`. Those are precisely the surfaces that mark selection, so the active-row accent bar and selected icons washed out on exactly the rows the user is trying to locate. The whole light brand family moved a stop darker to gold-700, which clears 3.9 everywhere.
2. **The light terminal ANSI ramp.** Inheriting VS Code Light+'s own terminal colours would have shipped green at **2.56** and bright-green/bright-yellow at **~2.1** on white. Green is not a decorative slot: it is what every test runner prints PASS in. The light ramp preserves hue and abandons Light+'s lightness.

Both were in the shipped-adjacent state and both looked fine.

## Why

A contrast miss in the 2.5 to 3.0 band is the dangerous one. Below about 2.0 it looks broken and you catch it immediately; above 3.0 it is fine. In between it reads as "slightly soft" on the display you happen to be using, at the brightness you happen to have, with the eyes you happen to have, and it is genuinely illegible for someone else. Author review is the worst possible instrument for it, because the author knows what the element says.

The second case adds a twist: the numbers were **inherited from a reputable upstream**. Light+ is Microsoft's own theme, and treating it as validated is exactly the shortcut that ships an unreadable PASS.

## It happened again, at scale, which settled the argument

Three months later the theme layer was rebuilt on generated palettes, and the same measurement was made a **mandatory build gate** rather than a one-off audit ([[concept_contrast_gate]]). Its first honest run failed **both bundled palettes in 31 places** - themes that had already shipped, been reviewed, and been looked at daily:

- white button labels at 3.20 on the danger fill;
- the focus ring at **2.52 dark and 1.70 light**, a WCAG 2.4.11 indicator that only reads if you already know where focus is;
- `ansi.brightBlack` at 2.90 on the terminal canvas;
- six coloured text roles in light against the panel head, and five VS Code Light+ syntax stops on the work card.

Most were **0.1 to 0.4 short**. Every one of them was in the invisible band. Three of the five *ported* themes needed moves too, one of them seventeen.

## What to do next time

Do not audit, **declare**. A one-off script proves the palette was fine on the day someone ran it; a rule table that every role must appear in fails the day someone adds a role. Make the declaration mandatory in both directions: a role with no rule is an error, and a rule naming a surface that no longer exists is an error.

When a theme or palette changes, compute the ratios over the full role set rather than reviewing screens. It is exhaustive where eyes are sampling, and it produces a number you can put in a comment next to the value so the next person knows the stop was chosen rather than picked.

Two corollaries worth keeping:

- **An inherited palette is not an audited one.** Upstream chose those values for their contrast requirements, not yours.
- **Weight the floor by what the slot means.** Terminal green got the strict treatment not because it is more visible than magenta but because programs use it to say the thing you most need to read.
- **A tier below the standard is fine if you name it as a trade-off.** Deliberately recessive text (comments, hints, inactive tabs) sits at 3.0 rather than 4.5, because forcing it to 4.5 flattens the hierarchy the UI leans on. What is not fine is calling that a WCAG category, or using it as a place to park a role that simply failed.
- **Measuring forces structure.** One stop cannot be both readable *as text* on the canvas and dark enough to carry a white label. Discovering that is how `danger.emphasis` and `success.emphasis` came to exist; no amount of looking produces that decomposition.

## Related

- [[concept_contrast_gate]] - this lesson, made executable and mandatory.
- [[concept_design_token_system]] - the token matrix this measured, and `scripts/check-tokens.mjs`, the guard that keeps it complete.
- [[component_theme_engine]] - where the light ramps live.
- [[lesson_measure_tokenization_before_css_migration]] - the same instinct one step earlier: measure the codebase before planning the migration, then measure the result before believing it.
