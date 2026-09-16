---
summary: chrome gets spacious density while editor and terminal stay dense, and the brand accent stays off the theme accent
status: current
updated: 2026-07-14
source: plan "Premium Design System for sway" (branch code-mirror-6); rollout Phases 1-7 complete
---

# Premium design system: two-tier density + a brand token family split from the theme accent

sway is being redesigned into one cohesive, premium look. Because sway is a dense IDE but the design inspiration is spacious SaaS, we adopt a **two-tier density model**: chrome (sidebar, toolbar, dialogs, settings, menus, toasts, buttons) is spacious with rounded inner containers and soft elevation, while work surfaces (editor, terminal, file tree, session tree, tabs) stay information-dense and are upgraded only via radii, hovers, typography, and iconography. Panes stay edge-to-edge (no floating cards); the premium feel comes from inner rounding + layered shadows, not pane insets.

The key structural decision: the brand accent is a **new, fixed `--brand-*` semantic token family, kept separate from the theme-following `--accent`.** The theme engine ([[component_theme_engine]]) lets users import VS Code themes that override `--accent` and the syntax tokens at runtime; folding the brand color into `--accent` would let an imported code theme mutate sway's identity. So chrome selection/focus/active bind to a fixed champagne-gold `--brand-*`, while `--accent`, syntax, and git/diff colors remain theme-driven and untouched. This extends the two-tier token structure of [[adr_ui_config_system]] rather than replacing it.

Supporting choices: bundle **Inter** for UI text (mono unchanged); use **Lucide** (`lucide-solid`) for all UI/nav/action icons via an `<Icon>` wrapper while **keeping Seti** colored glyphs for file types ([[component_seti_icons]]); add elevation tokens and codified chrome-vs-work spacing conventions to [[concept_design_token_system]]. Dark-first; light tokens are kept valid but full light QA is deferred. A hidden in-app `/styleguide` gallery is the per-phase QA surface.

## Consequences

- Every chrome component migrates its selection/focus/active styling off `--accent`/`--sel` onto `--brand-*`; the `.btn`/descendant-selector and dynamic-`classList` CSS-Modules gotchas must be honored during the migration.
- Adding `lucide-solid` and an Inter woff2 grows the bundle slightly; acceptable for the identity gain.
- Reversible in principle but touches nearly every styled surface, so treated as an architectural commitment.

## Outcome (rollout complete)

Shipped across all seven phases on branch `code-mirror-6`. The full Surface Inventory is on-brand: LeftSidebar gold pills + a left `--brand-bar` accent rail and uppercase section headers; spacious rounded dialogs / pickers / settings on `--shadow-lg` with a `--brand-ring` focus ring; the topbar and editor/terminal tab bars carry Lucide icons with a gold inset active-tab cap; FileTree/ReviewPanel rows became rounded dense pills. Exactly **two** editor-content sites stay theme-following by design: `.cm-selectionBackground` (`--sel`) and `.diffLine.hunk` (`--accent`); git/diff gutter colours and Seti file glyphs are untouched. Icon rule in practice: **static glyphs → Lucide via `<Icon>`, but bespoke data-viz SVG stays hand-drawn** (the Toolbar context gauge). A global `prefers-reduced-motion` guard neutralises the motion-token transitions. Brand + elevation ship valid light values, so theme-import repainting chrome light stays legible; the full light QA sweep in the running app is the remaining human step. Applied recipes + the elevation/motion tokens are documented in [[concept_design_token_system]]; the recurring hover/active ordering trap is [[gotcha_same_specificity_hover_and_active_declare_active_last]].

## Related

- [[concept_design_token_system]] — the token structure this brand family and elevation scale extend
- [[adr_ui_config_system]] — the two-tier tokens + theme engine this decision builds on and partially supersedes (brand accent no longer theme-derived)
- [[component_theme_engine]] — why the brand accent must be independent of imported code themes
- [[component_button]] — the primitive that carries the brand accent across the chrome
- [[component_seti_icons]] — kept for file types alongside the new Lucide UI icon set
