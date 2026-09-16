---
summary: reusing one keyframes name for enter and exit makes solid presence see no change and tear the panel down instantly
status: current
updated: 2026-08-16
source: "plan \"Re-audit Dialog and Tooltip against the solid-ui reference\" (personal/sway, branch `130-re-audit-dialog-and-tooltip`, issue #130); `node_modules/solid-presence/dist/index.js`, `@kobalte/core` 0.13.13; `src/components/Dialog/Dialog.module.css`"
---

# `solid-presence` decides there is no exit when both directions share an animation name

Do NOT write a Kobalte exit animation as one `@keyframes` reused in reverse. Kobalte keeps a closing dialog mounted through `solid-presence`, which decides whether an exit is running at all by comparing the computed `animation-name` across the open/closed flip (`isAnimating = prevAnimationName !== currentAnimationName`, where the previous name was captured at `animationstart`). Reuse the name in both directions and the two compare equal, presence concludes nothing is animating, and it goes straight to `hidden` - the panel is torn down instantly, the exit never plays, and the CSS reads as though it should. Name enter and exit separately (`dialogPanelIn` / `dialogPanelOut`). Nothing catches this: vitest hands back a class-name proxy and never parses the declarations, so the only detection is a human watching a dialog close. The same source is why `animation: none` under `prefers-reduced-motion` is safe rather than a hang - presence reads `none` as "nothing to wait for" and unmounts on the spot, instead of waiting for an `animationend` that will never fire.
