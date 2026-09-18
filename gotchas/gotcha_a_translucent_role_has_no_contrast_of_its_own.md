---
summary: measuring an rgba role's own channels against a background reports a colour never on screen, flatten to the composite
status: current
updated: 2026-07-24
source: "Native theming system: palette + roles generator (personal/tori, branch `terminal-editor-design`); Phase 6; `src/theme/contrast.ts`; commit db3abe9"
---

# A translucent role has no contrast of its own

Do NOT measure a wash's own channels against a background. What a reader sees is the **composite**, so an `rgba()` role must be flattened onto its surface *before* the ratio is computed, or you report a colour that is never on screen. Tori's focus ring is the case that proves it: `brand.ring` is a brand-tint wash, and measuring it naively hides that it landed at 2.52 dark and 1.70 light. `parseColor` returns channels plus alpha and `composite` flattens; only then does `contrastRatio` run. See [[concept_contrast_gate]].
