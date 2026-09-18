---
summary: give a thing a stable id separate from the name its consumers spell, a rename becomes one auditable table applied last
status: current
updated: 2026-07-24
source: "Native theming system: palette + roles generator (personal/tori, branch `terminal-editor-design`); Phases 1, 3, 4; commits 08c2307, ad31d34, 825c0bb; `src/theme/roles.ts`"
---

# Split a thing's identity from the name its consumers spell

## What happened

The theming rewrite had two goals that fought each other. It wanted a new engine (one JSON palette expanded by one generator, replacing two hand-written CSS blocks patched at runtime), and it wanted a new **name** for every token (Primer-style intensity scales, `--text` becoming `--fg-default`). Roughly 940 call sites across 38 files spelled the old names.

Doing both at once means the engine cannot be tested until the rename lands, and the rename cannot be verified until the engine works. Doing the rename first means touching a file that is about to be deleted. Both orders end in a single enormous commit that nothing can check.

The fix was to give every role **two** identifiers:

- `id`, the stable taxonomy (`canvas.card`, `fg.default`), which the palette, the ADR, the contrast rules, and every test key off;
- `cssVar`, the name CSS actually reads, which for three phases kept holding the **old** token names.

So the engine went live in Phase 1 emitting `--text` and `--bg`. Every guard could be built and pass in Phase 3, against a codebase that had not been touched yet. Phase 4 then flipped exactly one column, together with a codemod over the consumers, in one commit - and the proof it was purely nominal was already sitting there: a frozen pre-migration map, compared **per pair** (`built[new] === baseline[old]`), never as a set or a multiset of values.

## Why

Two reasons, and the second is the one that generalises.

**A rename is only safe when something else is already known-good.** By deferring the flip, the risky mechanical change was the *last* thing to happen, against an engine that had been running in production shape for two phases and a guard that already covered every var in the tree. Nothing had to be verified twice.

**The stable name is what everything else can be keyed by.** Because the taxonomy lived in `id`, none of the things that reference a role - the ADR, the palette schema, the contrast rule table, the workbench, the tests - had to move when the CSS name did. Three phases later, the split is still earning its keep for a reason unrelated to the rename: `contrast.ts` and `roles.test.ts` name roles by `id`, so a future CSS rename is a one-column change again.

## What to do next time

When a migration wants to change both an implementation and the name its consumers use, **separate the identity from the consumed name first**, and let the new implementation ship under the old names. Then the rename is a table, applied once, provable.

Three details that mattered more than expected:

- **Write the mapping table out literally, even the no-op entries.** 28 of 75 roles kept their name and were listed anyway, so "every role is accounted for" is a property of the table rather than of the reader's memory. A codemod over ~1000 sites has to be auditable in a diff, not the output of a regex nobody read.
- **One alternation, longest-first, bounded on both sides.** A per-name sequential `replace()` cascades: `--border` is a prefix of `--border-strong`, so an earlier entry rewrites a later entry's target, and the result still looks plausible in review.
- **Prove nominality per pair, never by value multiset.** A multiset is invariant under permutation, and several roles genuinely share a value (`--success-fg` and `--diff-added` are both `#2ea043` in dark), so a swapped mapping passes a multiset check unnoticed. Swapping two entries must fail, and there should be a probe that shows it does.

## Watch out

The frozen baseline is a **migration record, not a design freeze**. Once the contrast gate landed, 16 values legitimately had to leave it, and the honest answer was a named exception list checked two ways: an entry whose value never moved fails as stale, and an entry naming a role the baseline never covered fails as decorative. When the rename is history, retire the baseline, the rename table, and the codemod **together** - a surviving half reads as a considered exemption while exempting nothing.

## Related

- [[component_theme_engine]] - where `id` and `cssVar` live.
- [[concept_design_token_system]] - the token layer both names describe.
- [[lesson_measure_tokenization_before_css_migration]] - the earlier lesson this one is the sequel to: that one said measure before planning a CSS rewrite, this one says how to survive the rewrite you decide to do anyway.
- [[adr_theme_palette_roles]] - the ADR that fixed the taxonomy before 31 modules referenced it.
