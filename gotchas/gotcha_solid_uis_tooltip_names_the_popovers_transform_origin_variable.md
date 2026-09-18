---
summary: Kobalte namespaces the transform origin variable per control, copying the popover's name into a tooltip drops the zoom
status: current
updated: 2026-08-16
source: "plan \"Re-audit Dialog and Tooltip against the solid-ui reference\" (personal/tori, branch `130-re-audit-dialog-and-tooltip`, issue #130); `@kobalte/core` 0.13.13; `src/components/Tooltip/Tooltip.module.css`, `scripts/check-tokens.mjs` check 3"
---

# solid-ui's tooltip names the popover's transform-origin variable

Do NOT copy `origin-[var(--kb-popover-content-transform-origin)]` out of solid-ui's tooltip. Kobalte namespaces that custom property per component and sets the tooltip's own alias, `--kb-tooltip-content-transform-origin` (`dist/chunk/PKWJSNR5.js:59`, aliasing `--kb-popper-content-transform-origin`); the popover spelling is never set on a tooltip, so the declaration resolves to nothing, is dropped, and the zoom silently grows from the content's centre instead of its anchor. The reference is a starting point to verify against the substrate, not a source of truth - see [[lesson_a_design_reference_carries_its_own_bugs]]. Two further traps sit on the same line: a bare `var(--kb-*)` fails `check-tokens.mjs` check 3, because the name is Kobalte's and exists nowhere in `src/`, and the escape is the fallback form (`var(--x, center)`), which check 3 waves through by construction since a fallback *is* the declaration.
