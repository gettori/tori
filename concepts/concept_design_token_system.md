---
summary: two css tiers, primitives and generated semantic roles, with inline props on html outranking every stylesheet rule
status: current
updated: 2026-08-22
source: "Central configurable UI system (personal/tori, branch code-mirror-6); Phases 1, 5a, 5b; commits 56af1ca, abe9429, 932f8ef; brand rollout: Premium Design System for tori, same branch; completed + enforced: v0.1 release gate (branch `topbar`) Phase 3, commit 3275344; rebuilt on palettes: Native theming system: palette + roles generator (branch `terminal-editor-design`), Phases 1-7, commits 08c2307 through db3abe9"
---

# Two-tier design-token system

**Location:** `src/styles/{reset,tokens,base}.css`, `src/panels/Settings/settingsStore.ts` (`applySettings`), `index.html` (`data-theme`), `scripts/{gen-tokens,check-tokens}.mjs`

How Tori's styling went from a 2015-line hardcoded `App.css` (only 10 CSS vars, everything else raw hex) to a themeable token layer, without rewriting the component CSS. This is the substrate [[component_theme_engine]] and [[component_settings_store]] paint onto.

> **Since the palette rewrite**, the semantic tier is *generated*: one JSON palette expanded by `roles.ts` into 110 roles, with both `tokens.css` theme blocks emitted from the two Tori palettes. The history below is still how the layer got here, and the naming, layering, and guard sections remain live. What is obsolete is the VS Code runtime-mapping tier and the idea that a colour has to be added to two hand-written blocks.

## The two tiers

- **Primitives** (`--tori-*`, in `tokens.css :root`): raw, theme-independent values, the neutral ramp (`--tori-gray-50`…`--tori-gray-990`), blues, spacing scale, radii, font-size scale, font-family stacks, border widths, motion durations. The fallback ladder; never consumed directly by chrome that needs to re-theme.
- **Semantic** role tokens the UI actually consumes (`--bg`, `--pane-bg`, `--border`, `--text`, `--text-dim`, `--accent`, `--sel`, `--hover`, `--input-bg`, plus status `--danger`/`--warn`/`--warn-strong`/`--success` and `--syn-*`). Defined **twice**, once under `:root, :root[data-theme="dark"]` and once under `:root[data-theme="light"]`, each selecting different primitives. The dark set maps **1:1 to the exact hex** that used to live in `App.css :root`, so dark rendering is byte-identical after the refactor (verified in the built CSS). (`--success`, the green approve color, was added later for [[component_button]]'s `success` variant, dark `#2ea043` = the `var()` fallback so dark stayed byte-identical, light `#1a7f37`.)

Theme switching is a single attribute flip on `<html>` (`data-theme="dark|light"`); no JS is required for the static default because `index.html` ships `data-theme="dark"` (FOUC-free boot).

## Layering and the deliberate un-layered App.css

`reset.css` (the first import) declares the cascade order once: `@layer reset, tokens, base, components;`. Tokens live in `@layer tokens`, base element styles in `@layer base`. **`App.css` is intentionally left un-layered** so its component rules keep winning over the layered base until each is migrated, letting the token layer land with zero visual regression and no big-bang CSS rewrite. (Measuring first showed the rewrite was mostly unnecessary, see [[lesson_measure_tokenization_before_css_migration]].)

## Runtime override path

Two sources write inline props on `<html>`, above the stylesheet:

1. `tokens.css`'s per-`data-theme` blocks, the pre-theme fallback. **Generated** from the two Tori palettes into a marker-delimited region inside `@layer tokens`; hand-editing it fails the guard.
2. The [[component_theme_engine]] resolver paints the active theme's 110 resolved roles.
3. [[component_settings_store]]'s `applySettings` paints settings-driven tokens (`--ui-scale`, `--ui-line-height`, `--editor-font-*`, `--tori-font-ui`).

Because inline props outrank *every* rule in the token layer, 2 and 3 are bound by an explicit **key-ownership contract**: disjoint key sets, only ever overwrite your own keys, never clear the element's style wholesale. That is what keeps `--ui-scale` alive across a theme switch, and it is recorded in [[adr_theme_palette_roles]] rather than left as a convention.

`--ui-scale` is the root of a font-driven scaling layer: one multiplier folds through the type ramp, the `--tori-space-*` scale, and the `--control-*` tokens so the whole chrome zooms uniformly. See [[concept_ui_scaling_system]].

## Brand, elevation, motion (what chrome consumes)

The premium redesign ([[adr_premium_design_system]]) added three token groups that chrome binds to, all defined **twice** (dark + light) like the rest:

- **Brand family** `--brand`, `--brand-strong`, `--brand-subtle` (translucent selection fill), `--brand-bar` (the left active-item accent rail + the inset active-tab cap), `--brand-ring` (the focus ring), `--brand-on` (legible text/icon on a filled `--brand`). Fixed champagne-gold, **independent of the accent role** so a ported theme cannot mutate Tori's identity. All five bundled palettes carry the identical brand family, and so must any user theme.
- **Elevation** `--shadow-sm/md/lg` (soft on dark, softer on light). Floating chrome uses `--shadow-md` (menus, popovers) or `--shadow-lg` (dialogs, quick-open, settings); dense work surfaces use at most `--shadow-sm`.
- **Motion** primitives `--tori-duration-fast`/`--tori-duration-med` + `--tori-ease` drive every hover/active/focus transition. A single global **`@media (prefers-reduced-motion: reduce)`** reset in `base.css` (outside `@layer`, `!important` on `*`/`::before`/`::after`) neutralises all of them app-wide, so components never guard motion individually.

Recurring recipes: rounded container + `--shadow-lg` + a `--brand-ring` focus ring (`box-shadow: 0 0 0 3px var(--brand-ring)`); active rows are a `--brand-subtle` pill, sub-items add a `--brand-bar` rail. Order the selected rule after `:hover`, see [[gotcha_same_specificity_hover_and_active_declare_active_last]].

## Migration completed, and enforced (v0.1)

Shipping full light mode meant finishing the job: **589 colour literals** across `src/` moved onto the token layer. They sorted into four categories, and naming them is most of the work:

1. **`var(--token, #fallback)` fallbacks** - dead weight, and actively wrong in light if they ever fired.
2. **A diff/VCS family** (`--diff-added`/`--diff-modified`/`--diff-deleted`), deliberately **kept separate from `--success`/`--warn`/`--danger`**. The two families had drifted to different hues long before the token layer existed (`#d29922` vs `--warn` `#d19a66`), so collapsing them would have silently restyled every diff view. They are genuinely different roles: UI feedback vs. labelling added/modified/deleted content.
3. **Scrims** (`--scrim`, `--scrim-soft`) and `--fill-subtle`.
4. **One-off accents**, folded into existing tokens.

Two structural additions:

- **Traffic lights are primitives, not semantic tokens.** They mimic the macOS window buttons, which look identical in both themes, so they must **not** follow the theme. Putting them in `:root` keeps the audit clean without punching an allowlist hole.
- **The 16-slot ANSI terminal ramp had to be tokens**, not derivation. Unlike the rest of the chrome, a *program* picks the ANSI slot, so the colours cannot be computed from `--bg`/`--text`. See [[component_theme_engine]].

**Dark is no longer byte-identical, in 4 places, deliberately** (sidebar badge and its fill alpha, the context meter, the transcript error badge). Each was a near-duplicate of an existing token, and minting four more tokens to preserve exact pixels would have defeated the migration.

### The blocking tier (2026-08-22)

Four roles, `blocking.surface`, `blocking.border`, `blocking.fg` and `blocking.accent`, for a surface that has stopped the turn and is waiting on the user. Two of those exist (the chat's permission prompt and its question card) and each spelled the same thing out as `--brand-default` over `--canvas-card`, which is the colour the chat pane itself paints: a card that had stopped the turn was a gold hairline and nothing more, and neither could be restyled without moving the brand everywhere else too. Same argument the tree and tab families already carry, a role currently equal to another is not redundant if the two are free to diverge.

The fill is a warm step above the pane, mixed and opaque for the reason `brand.wash` documents, and its **amount is a ceiling the palettes set rather than a look that was chosen**: 0.04 dark and 0.07 light, past which the recessive labels inside the card fall under their floors. See [[lesson_a_new_surface_leaves_its_text_unmeasured]].

### `scripts/check-tokens.mjs`, the guard

Wired into `pnpm test`, because a guard nobody runs is decorative. It lives here rather than in vitest because nothing in the test stack can see the token layer at all, see [[gotcha_vitest_stubs_css_imports_to_the_empty_string]]. **Ten checks**, and the four added since this page first listed six are all of the same kind, a name or a shape no CSS tooling can see:

1. **No colour literal outside `tokens.css`**, with an allowlist where every entry carries a stated reason (and a staleness check: an entry naming a deleted file fails, because it reads as a considered exemption while exempting nothing). Covers 3/4/6/8-digit hex, `rgb(`, `rgba(`, `hsl(`, and CSS named colours. Named-colour detection skips words followed by `:` (in CSS a named colour is always a value, so it is never followed by a colon) and words preceded by `.` (a role id like `ansi.black` never is).
2. **Every bundled palette produces every declared role**, and the generated region of `tokens.css` agrees byte-for-byte with what the generator emits today. Derivations fail as *strings*, not exceptions, so this tests the value for `undefined|NaN|var(` rather than trusting a try/catch.
3. **Every `var(--x)` in `src/` resolves** to a role, a `--tori-*` primitive, or a locally declared property. `var(--x, fallback)` is exempt on principle: the fallback *is* the handling of absence. Dynamically built names are allowlisted per file **and** per prefix, never skipped wholesale.
4. **Every name `TerminalView.termColors()` reads** is a declared role.
5. **Every token the theme workbench names** as a literal resolves.
6. **Every hue the generated seti mapping emits** has a `scale.*` role, see [[component_seti_icons]].

7. **Every role the semantic-token layer paints with** has a `--syntax-*` role.
8. **The Omnibox palette asks Dialog for its own shorter height bound**, since nothing above the palette bounds it.
9. **The palette's own heading still matches Dialog's title recipe** on all four properties, because the palette hides its real title and draws a copy.
10. **The two blocking surfaces in the chat wear one tier, and nothing else wears it.** The frame, the fill and the radius are compared as *declarations* rather than as colour: two rules that happen to name the same gold drift the first time one is edited, invisibly, because both still look gold. It also fails on a tier role nothing reads.

Checks 4 through 10 exist because those names are TypeScript string literals, are built at runtime, or live in a stylesheet no test can read; a stale one degrades silently rather than failing. Each check asserts its own extractor, so a renamed const fails loudly instead of passing vacuously. Every check has been verified load-bearing by a planted negative.

## Watch out

- A `var(--x, fallback)` whose `--x` is never defined renders fine but freezes the value out of theming, invisible debt, see [[gotcha_var_fallback_tokens_silently_hide_un_themed_values]]. (The `var(--danger|--warn|--success, #hex)` fallbacks are safe: those tokens **are** defined in both theme blocks.)
- **Adding a colour means adding a palette primitive and a role**, not an allowlist entry. The allowlist is for files that legitimately hold literals (the palettes, the workbench), not for convenience.
- A complete token matrix guarantees no *un-themed* surface; it guarantees nothing about **contrast**. That is now enforced, see [[concept_contrast_gate]] and [[lesson_measure_contrast_dont_look]].
- The white-button-label and `--sel` misses noted here as "left for a deliberate decision" were **measured and fixed** in the palette rewrite: the deliberate decision was to move the values, and it produced the `danger.emphasis` / `success.emphasis` split.

Recorded in [[adr_theme_palette_roles]], which supersedes the theme-engine half of [[adr_ui_config_system]].
