---
summary: an inline SVG's <style> applies to the whole document; prefix its classes, keyframes and ids, and scope its reduced motion rule
status: current
updated: 2026-09-25
source: branch orchestrator for gettori/tori#207, commits cec896d9, df821076; src/components/Autopilot/scenes/*.svg; src/components/Autopilot/Horizon.tsx
---

# An inline SVG's style block is global

**Trap.** The cockpit scenes animate from a `<style>` inside each SVG, and have to be inline to do it (an `<img>` would also lose `var(--canvas-default)` on the last wave). Inline, that `<style>` is a document stylesheet: its `.d`, `.tw`, `.glow` classes and `drift`, `glow` keyframes apply to the whole app, and ids like `sky` and `sea` collide between two scenes on screen during a cross fade.

**The sharp one.** Each scene shipped `@media (prefers-reduced-motion: reduce) { * { animation: none !important } }`. Inline, that stops every animation in Tori, not just the scene's.

**What the scenes do.** Classes and keyframes carry a `ts-` prefix, ids the scene's key (`night-sky`), the root `<svg>` has `class="tori-scene"`, and the reduced motion rule reads `.tori-scene, .tori-scene *`. A new scene from a design handoff needs the same pass before it lands.

**Also.** The token guard reads `.css`, `.ts` and `.tsx` only, so the colours inside a scene are not checked; they are picture data, drawn the same in every theme.

## Related

- [[component_autopilot_parts]]: `Horizon` and the scenes
- [[concept_design_token_system]]: what the guard does read
