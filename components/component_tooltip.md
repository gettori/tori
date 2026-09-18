---
summary: tooltip only animates in, never out, since Kobalte never wraps tooltip content in presence so there is no closing frame
status: current
updated: 2026-08-16
source: "plan \"Re-audit Dialog and Tooltip against the solid-ui reference\" (personal/tori, branch `130-re-audit-dialog-and-tooltip`, issue #130, part of #93); `src/components/Tooltip/Tooltip.tsx`, `Tooltip.module.css`, `src/lib/tooltip.ts`; originally built by plan \"Tooltip primitive and the `title=` sweep\" (branch `102-tooltip-primitive`, issue #102); commits c996ca9, 9826e7e"
---

# `Tooltip`: the one tooltip surface

Kobalte's tooltip behind Tori's chrome, on [[component_lib_boundary]]. This page is the **recipe and the composition**: what the surface is made of and what its values are. The rule the whole design turns on - the trigger has to *be* the control, so `as` names a host to render rather than accepting a built one - lives in [[concept_tooltip_trigger_is_the_control]], along with the generic props, the no-label fast path, and `whenDisabled`.

## Composition

`Root` > (`Trigger` as the control) + `Portal` > `Content`. Four parts, and `src/lib/tooltip.ts` re-exports exactly those four: `Arrow` is left out deliberately, because Tori draws none and a re-export nothing composes reads as supported surface.

`Portal` takes a `mount`, defaulting to the enclosing dialog's panel and falling back to `document.body`. A dialog aria-hides everything outside its panel, so a body-portalled tooltip inside one would be painted on screen and invisible to a screen reader at once. See [[component_dialog]]'s surface seam.

## The recipe

| Part | Value |
|---|---|
| Padding | `var(--tori-space-3) var(--tori-space-5)` (6 / 12) |
| Type | `--tori-text-lg`, `--tori-line-normal` |
| Surface | `--canvas-card`, `1px solid --border-default`, `--tori-radius-md`, `--shadow-md` |
| Text | `--fg-default` |
| Width | capped at `280px * --ui-scale`, `white-space: pre-wrap` |
| Stacking | `z-index: 1300`, the top of the ladder (menus 1000, omnibox 1100, toasts 1200, dialog 1250) |
| Motion | `tooltipContentIn` on `[data-expanded]`, `--tori-duration-fast`, fade + `scale(0.95)` |
| Origin | `transform-origin: var(--kb-tooltip-content-transform-origin, center)` |
| Standoff | `gutter={4}` on `Root` |

**The cap earns its place.** A tooltip label is usually a phrase, but the ones naming a path or a branch are not, and 280px with no wrapping would clip them.

**`pointer-events: none`.** It follows the pointer around by construction; taking the pointer back would make the control under it unhoverable at the overlap.

## Two values that are not tokens, and why

**`gutter={4}`** is the one dimension in either wrapper that cannot be a token and never will be: the popper takes a number, not a length, so `--ui-scale` never reaches it. It could be computed by reading the scale back out of the settings store, but that imports a panel-level store into a `components/` primitive to move a tooltip by two pixels at the extremes of the zoom range. Recorded as a deliberate keep (#130).

**`--kb-tooltip-content-transform-origin`** is Kobalte's, written as an inline style on the content and pointing at whichever corner the popper resolved to, so the zoom grows out of the trigger rather than out of nothing. It carries a `center` fallback because the name exists nowhere in `src/` and `check-tokens.mjs` check 3 fails any `var()` that resolves to nothing unless it handles its own absence. See [[gotcha_solid_uis_tooltip_names_the_popovers_transform_origin_variable]].

## Motion is one-directional, permanently

The tooltip animates **in** and not out, and that is a property of the substrate rather than a preference. Kobalte does not run tooltip content through `solid-presence` the way the dialog does (`dist/tooltip/index.js` never calls `createPresence`), so the content is unmounted the instant the tooltip closes and there is no closing frame for an exit keyframe to land on. A `[data-closed]` rule here would be a rule that matches nothing, which reads in review as motion that exists and does not. The reference agrees by omission: solid-ui's tooltip ships an enter animation and no exit. See [[gotcha_kobaltes_tooltip_content_is_not_wrapped_in_presence_so_it_can_only_animate_in]].

Enter is `--tori-duration-fast` rather than the dialog's `--tori-duration-med`: the 500ms open delay already made the user wait, and the animation is confirming a pointer that has arrived.

## Delays

500ms open, 300ms close, 300ms skip. Slower to open than Kobalte's 700 default is *faster*: 700 is what "the tooltips are slow" means on a toolbar. The skip delay is Kobalte's own value, restated because it is a design decision - within 300ms of one tooltip closing the next opens instantly, so sweeping a row of icon buttons reads as one gesture instead of eight waits. That timer is module-global inside Kobalte, so every tooltip sharing the value *is* the grouping mechanism.

#130 left all three untouched.

## Connections

- [[concept_tooltip_trigger_is_the_control]] - the behaviour and API half; read it first if you are changing what `Tooltip` accepts rather than how it looks
- [[component_dialog]] - the other wrapper #130 audited, and the surface this one portals into
- [[component_lib_boundary]] - why `@kobalte/core` is only ever named in `src/lib/`
- [[concept_design_token_system]] - the ramps every value above is snapped to
- [[adr_solid_ui_reference]] - where the proportions came from
- [[component_button]], [[component_tab]], [[component_icon_grid]] - the controls that pass `tooltip` straight through
