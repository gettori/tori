---
summary: a Lucide icon's size prop sets svg width and height attributes, not CSS, so scale icons with a CSS rule instead
status: current
updated: 2026-07-27
source: plan "A font-driven scaling system + unified controls" (personal/sway, branch `terminal-editor-design`); Phase 4; `src/components/Icon/Icon.tsx` + control CSS
---

# Lucide `size` renders to SVG attributes, so scale icons in CSS

A Lucide `<Icon size={N}>` renders `N` to the svg's `width`/`height` **attributes**, not CSS, so `var()`/`calc()` cannot reach it and a numeric prop can never track `--ui-scale`. To make an icon scale (or to restyle its size at all), set a CSS `width`/`height` on the svg, which overrides the presentation attributes. In Sway: icons inside a control just drop the prop and inherit `--control-icon`; standalone icons take a parent-scoped `svg { width/height: calc(N * var(--ui-scale)) }` rule. So the numeric `size` prop is dropped at every real chrome call site, leaving only `Icon`'s 16px default (for un-migrated sites) and the two Styleguide demos of the prop itself. Related: [[concept_ui_scaling_system]].
