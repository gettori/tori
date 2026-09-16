---
summary: solid ui is copied for composition and spacing only, never as a package, since Sway tokens and Tailwind never mix
status: current
updated: 2026-08-15
source: Design-system discussion during the Kobalte primitives program (2026-08-15), branch redesign, ticket skarif2/sway#93. Follows the wholesale-adoption decision of [[adr_headless_primitives]]
---

# solid-ui is the design reference for wrapped components: copy composition and proportions, never code, classes, or tokens

Building the #93 wrappers surfaced a real cost that the primitives program did not budget for: per-component design decisions. Every wrapper needs answers to "how should this look" (padding of a menu item, gap in a dialog footer, radius on a popover, size relationships between controls) and Kobalte, being headless, answers none of them. Deciding each from scratch is slow and produces inconsistency; adopting a styled library wholesale was already rejected. We resolve it by adopting **solid-ui** (the shadcn/ui port for Solid, itself built on Kobalte) as a **reference, not a dependency**, in exactly two ways:

1. **Composition patterns.** When a wrapper ticket starts, read how solid-ui composes the same Kobalte parts (which parts, in what nesting, what goes in a portal, where the close affordance sits). Keep the structure, discard the styling. This is free because the behavioral substrate is the same library.
2. **Design values.** solid-ui's visual decisions (spacing rhythm, type usage, radius relationships, per-component recipes) are the default answer to "how should this look". Each value is translated into Sway's own tokens: the nearest `--sway-space-*` / `--sway-radius-*` / type-ramp step, role tokens for every color. The recipe is recorded in the wrapper's component page as token names, at which point solid-ui has served its purpose for that component.

**Never crosses the boundary:** the `solid-ui` package, copied component files, Tailwind, the `cn()`/`tailwind-merge` pair, and the shadcn variable vocabulary (`--primary`, `--muted`, `--radius`, ...). Sway's guard scripts (`check-tokens.mjs`, the `lib/` import boundary) are unchanged and would reject most of that list anyway; this ADR makes the rejection a decision rather than an accident.

Where solid-ui's proportions fight Sway's identity, Sway wins: [[adr_premium_design_system]]'s two-tier density means dense work surfaces (trees, lists, terminal chrome) deliberately undercut shadcn's airy web-app spacing, and the `--brand-*` family is untouchable. The reference covers only the generic-component slice; it has no opinion on layout, information architecture, or the app chrome that stays native.

## Considered Options

- **Full migration to solid-ui** (rejected): performance was measured as a non-issue (Tailwind is build-time, `cn()` runs at component creation in Solid), so that was not the reason. The reasons: its catalog covers almost exactly the slice #93 already shipped or scoped (dialogs, menus, tooltips, form controls) and none of Sway's majority surface (editor, tab strip, panes, sidebar tree, terminal, diff views, Omnibox), so the design decisions it removes would return immediately for everything else; and it would discard the runtime theme engine, `--ui-scale` zoom, the contrast gate, and the token guards, which are shipped features.
- **Adopt solid-ui components, remap Tailwind's theme onto Sway tokens** (rejected): Tailwind's scale is compile-time and Sway's tokens resolve at runtime (theme flip on `data-theme`, inline props from the theme engine, live `--ui-scale`), so the remap is partial by construction; the two ramps do not align step-for-step, making every mapping a judgment call and every boundary a seam; and remapped proportions invalidate the copied components' original design anyway, forcing the per-component audit the adoption was meant to avoid.
- **Design each wrapper from scratch** (rejected): the status quo, and the trigger for this ADR. Undifferentiated design work with an inconsistency risk that grows with every wave of #93.

## Consequences

- Wrapper tickets (#103 onward) gain a first step: read the solid-ui counterpart for part composition and starting values before writing the wrapper. Already-shipped wrappers ([[component_dialog]], tooltips) are **re-audited** against the reference in the same way: compare composition and recipe values, adopt what improves consistency, express any change in Sway tokens. The audit is a one-time pass, scoped as its own ticket (skarif2/sway#130) so it does not block the remaining waves.
- Extracted recipes live in the wiki as token names on component pages, never as references to solid-ui, so a future reader needs no knowledge of the reference to maintain a component.
- The reference is a point-in-time snapshot. solid-ui drifting or dying costs nothing: no dependency exists, and everything taken is already translated into Sway's system.
- If a needed value has no home in the ramps, the fix is a new Sway primitive per [[concept_design_token_system]]'s rule (a palette primitive and a role, not an allowlist entry), never importing solid-ui's value verbatim as a literal.

## Related

- [[adr_headless_primitives]] - the wrapper program this reference feeds; same Kobalte substrate is what makes composition-copying free
- [[adr_premium_design_system]] - the visual identity that overrides the reference wherever they disagree
- [[adr_theme_palette_roles]] - the role system every borrowed color decision must be expressed in
- [[concept_design_token_system]] - the ramps borrowed proportions are snapped to, and the guards that keep the boundary honest
- [[component_dialog]] - first shipped wrapper family; predates this ADR, covered by the one-time re-audit
