---
summary: themes are flat palettes expanded by one roles.ts generator, each role's stable id split from the cssVar CSS reads
status: current
updated: 2026-07-24
source: "plan \"Native theming system: palette + roles generator\" (branch terminal-editor-design); Phases 1-7; commits 08c2307, ad31d34, 825c0bb, 809cbdc, db3abe9"
---

# Theme palettes resolve through one role generator, with role identity split from CSS variable name

> **Shipped.** All seven phases landed. The `cssVar` flip happened in Phase 4 (940 sites, 38 files, one commit); the taxonomy settled at **110 roles** rather than the ~145 sketched below, because Phase 5 added `tree`, `tab`, `activity`, `editor`, and `scale.*` but did not need every `{fg, emphasis, muted, subtle}` completion. The gate and user themes are live. See [[component_theme_engine]].

Sway is replacing its light/dark binary with named, complete themes (Sway Dark, Sway Light, plus ports). Rather than hand-maintaining two blocks of CSS custom properties per theme and patching them at runtime from a partial VS Code mapping, each theme is a **flat JSON palette of primitives** that one shared `roles.ts` generator expands into the full role set. Authors write ~45 primitive values; the generator derives the rest through `alpha()`, `mix()`, and a `variants({light, dark})` escape hatch.

The load-bearing decision is that **every role carries two independent identifiers**: a stable `id` (`canvas.card`) and a `cssVar` (`--pane-bg`). The `id` is the taxonomy and never changes again. The `cssVar` is what CSS consumes, and it holds the *current* names through Phases 1 to 3 so the new engine is live and every guard is satisfiable before a single module is renamed. Phase 4 flips only the `cssVar` column together with its consumers, in one commit. Without this split the rename and the engine rewrite would have to land simultaneously across ~467 `var()` sites, which is precisely the shape of migration that [[lesson_measure_tokenization_before_css_migration]] recorded as scoped, measured, and dropped.

## Role taxonomy

Families use uniform intensity naming (Primer's `fg.default` / `fg.muted` / `fg.subtle` / `fg.onEmphasis` shape) so a role's weight is legible from its name. `cssVar` is derived mechanically from the `id` at the Phase 4 flip: `family.memberName` becomes `--family-member-name`.

Phase 1 ships the **75 roles that have values today**, one per declaration in the current `tokens.css` theme blocks (68 in the dark block plus the 7 `--syn-*` that live in `:root`). This is deliberate: Phase 1's correctness proof is that the generator reproduces the existing token layer exactly, key by key and value by value, against a frozen baseline. A role with no current value could not participate in that proof.

| Family | Roles (Phase 1) | Current `cssVar` |
|---|---|---|
| `fg` | `default`, `muted`, `subtle`, `onEmphasis` | `--text`, `--text-dim`, `--text-faint`, `--on-solid` |
| `canvas` | `default`, `card`, `head`, `input` | `--bg`, `--pane-bg`, `--pane-head-bg`, `--input-bg` |
| `border` | `default`, `strong`, `rail` | `--border`, `--border-strong`, `--graph-rail` |
| `scrollbar` | `thumb`, `thumbHover` | `--scrollbar-thumb`, `--scrollbar-thumb-hover` |
| `accent` | `fg`, `subtle` | `--accent`, `--sel` |
| `neutral` | `hover`, `subtle` | `--hover`, `--fill-subtle` |
| `danger` | `fg` | `--danger` |
| `attention` | `fg`, `emphasis` | `--warn`, `--warn-strong` |
| `success` | `fg` | `--success` |
| `info` | `fg` | `--info` |
| `diff` | `added`, `modified`, `deleted`, `addedWord`, `deletedWord` | `--diff-*` |
| `diag` | `error`, `warning`, `info`, `hint` | `--diag-*` |
| `agent` | `claude`, `pi` | `--agent-*` |
| `scrim` | `default`, `soft` | `--scrim`, `--scrim-soft` |
| `status` | `progress`, `needsYou`, `idle`, `running` | `--status-*` |
| `brand` | `default`, `strong`, `subtle`, `bar`, `ring`, `on` | `--brand*` |
| `ansi` | `cursor`, `selection`, `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `brightBlack`, `brightRed`, `brightGreen`, `brightYellow`, `brightBlue`, `brightMagenta`, `brightCyan`, `brightWhite` | `--term-*` |
| `shadow` | `sm`, `md`, `lg` | `--shadow-*` |
| `shell` | `glow`, `cardShadow` | `--shell-glow`, `--work-card-shadow` |
| `syntax` | `keyword`, `string`, `comment`, `number`, `function`, `type`, `variable` | `--syn-*` |

Phase 5 widens the schema to roughly 145 roles by filling families the current layer never had: `syntax` from 7 to 20 categories, a `tree` family (row states, indent guides, chevrons), a `tab` family, an `editor` family for CM6 chrome (gutter, line highlight, matching bracket, search match), the `scale.*` set of 11 icon hues that frees `seti/mapping.ts` from hardcoded upstream colours, and the `{fg, emphasis, muted, subtle}` completion of the `accent` / `danger` / `attention` / `success` / `info` / `neutral` families. Those roles are named in the taxonomy now so the families are settled before 31 modules reference them, but they carry no value until the phase that adopts them.

`brand`, `status`, and `agent` are in the schema but stay **outside palette control** by default, preserving [[adr_premium_design_system]]: an imported or user-authored theme must never repaint the champagne-gold identity, the session indicators ("agent needs you"), or third-party brand marks.

## What this took from primer/github-vscode-theme, and what it deferred

The design is modelled on Primer's generator (721 lines, 229 workbench keys derived from ~50 semantic primitives, 7 variants from one mapping file). Recording the split so future theming work does not re-derive it:

**Taken**

- **One generator, many themes.** A palette file is the only thing an author writes; every derived value has exactly one definition.
- **Uniform intensity naming.** `fg.default` / `fg.muted` / `fg.subtle` / `fg.onEmphasis`, so a role's weight is legible from its name and a missing member is obvious.
- **Derivation helpers over hand-tuned rgba.** `alpha()` and `mix()` replace washes that were otherwise authored twice, once per theme.
- **A per-variant escape hatch.** `variants({dark, light})` for the exceptions, instead of forcing every value through one rule.

**Deliberately not taken**

- **229 roles.** Sway ships 110. Primer's largest group is `symbolIcon` at 33 keys for IntelliSense symbol kinds Sway does not have; the comparable surface here is 31 CSS modules, and an unused token rots silently because nothing renders it.
- **Generated variants.** High-contrast, colourblind, and `dark_dimmed`-style low-contrast variants are exactly what a generator makes cheap, and are deliberately out of scope for now. The machinery is in place if they are wanted.
- **Semantic highlighting.** `semanticHighlighting` / LSP token types; Sway's ramp is TextMate-style categories only. `syntax.parameter` exists but has no real consumer, because Lezer has no parameter tag - it is mapped to `t.local(t.variableName)` as the closest lexical proxy, with the replacement rule named in a comment.
- **Per-surface role groups.** Primer splits roles per workbench surface; Sway keeps one shared set and adds a family only when a surface genuinely needs to diverge (which is what `tree`, `tab`, and `activity` are - they shipped as exact aliases of the roles they replaced, so a theme *can* restyle tree selection without moving every focus ring, and a test pins the aliasing so a future divergence arrives as a failing test rather than a surprise screenshot).
- **Per-role user overrides.** Users author whole palettes, not role maps on top of one.

## The `<html>` key-ownership contract

Three writers set inline custom properties on the document element, and they must never fight:

- **the theme resolver** owns exactly the role `cssVar` set, and no other key;
- **`settingsStore.applySettings`** owns `--ui-*` and `--editor-font-*` (post the scaling rework, `--ui-*` is just `--ui-scale` + `--ui-line-height`; the `--ui-density`/`--ui-radius-scale` knobs were removed, see [[concept_ui_scaling_system]]);
- **the themes watcher** (Phase 7) writes through the resolver and owns nothing of its own.

Each writer **only ever overwrites its own keys and never clears the element's style wholesale**. The rule exists because inline props on `<html>` outrank `:root[data-theme="light"]`, so a writer that clears or blanket-writes silently destroys another's values, and a resolver that writes a fallback for an absent key pins a hardcoded value above the token layer where no theme can dislodge it. The pre-existing `out[cssVar] = hit ?? fallback` in `resolver.ts` is exactly that bug, and Phase 1 removes it.

## Consequences

- The taxonomy is expensive to change once 31 CSS modules reference it, which is why it is fixed here before Phase 4 rather than discovered during the rename.
- Palette JSON carries **flat hex values only, no expressions**, so a user-authored theme is never an evaluator or an injection surface. All derivation lives in `roles.ts`.
- Structural completeness (serde validation) cannot reject white-on-white, so a contrast gate ships in Phase 6, before user themes can load in Phase 7. See [[concept_contrast_gate]].
- **Validation is Rust, the gate is TypeScript, and the seam is deliberate.** The gate measures roles, and roles do not exist until `roles.ts` derives them, so a Rust gate would be a second definition of the theme, free to drift. `palette.rs` covers the structural half; nothing paints until `applyResolved` is called, so gating on the frontend still refuses a bad theme before the first paint.
- VS Code theme import is dropped entirely rather than ported, superseding that half of [[adr_ui_config_system]].

## Related

- [[concept_design_token_system]] — the two-tier token structure this generator now produces
- [[concept_contrast_gate]] — the legibility half of the two-stage door
- [[component_theme_engine]] — the runtime this replaces, minus its VS Code mapping layer
- [[lesson_split_identity_from_consumed_name]] — what the `id`/`cssVar` split bought, in retrospect
- [[adr_ui_config_system]] — supersedes its importable-VS-Code-theme half
- [[adr_premium_design_system]] — the fixed `--brand-*` split this preserves
- [[lesson_measure_tokenization_before_css_migration]] — why the `cssVar` indirection exists
- [[lesson_measure_contrast_dont_look]] — why the Phase 6 gate is arithmetic, not review
