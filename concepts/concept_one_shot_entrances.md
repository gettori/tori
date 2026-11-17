---
summary: an in-pane entrance is a class added once and removed on animationend, since display none restarts any CSS animation
status: current
updated: 2026-11-17
source: plan "Visual polish pass with a Storybook kitchen sink" (personal/tori, branch ui-rework), phases 1, 3 and 4; src/utils/enterOnce.ts:8; src/styles/patterns.module.css:60; src/panels/Chat/MessageList.tsx:98; commits 844ac739, 4b00a3f1, 0a201512
---

# One-shot entrances

Panes hide with `display: none` and stay mounted, and a CSS animation restarts every time its element is displayed again. A plain mount keyframe inside a pane would therefore replay on every tab switch, every pane toggle and every background tab coming forward. So an entrance inside a pane is a class that is added once and taken off as soon as it has played, and a state change is a transition, never a keyframe. Portaled overlays (menus, select, popover, dialog, tooltip) are exempt: they mount fresh each time they open.

## How it works

- `enterOnce(el, className)` in `src/utils/enterOnce.ts:8` is called from a `ref`. It adds the class only when the element has a layout box (`getClientRects().length > 0`), so an element created inside a hidden pane never plays at all, and removes it on `animationend`, `animationcancel` or a 600ms fallback. Animation events are filtered to `e.target === el`, because a child's `animationend` bubbles.
- It runs where Solid runs `onMount`: after insertion, before paint, so there is no unanimated first frame.
- The shared keyframes are `popIn` (`.enterPop`, scale from .95) and `riseIn` (`.enterRise`, 4px times `--ui-scale`) in `src/styles/patterns.module.css:60`, at `--tori-duration-med` and `--tori-ease-out`. They animate the individual `scale` and `translate` properties, not `transform`, so a consumer's own transform and its `transform-origin` survive.
- Keyframes are `from` only, so reduced motion lands on the base style, see [[gotcha_reduced_motion_lands_on_the_base_style_not_the_last_keyframe]].
- Ticks and dots animate by transition on a force-mounted indicator, for the same replay reason.

## The live-row rule

The transcript decides "this row is new, rise it in" in `MessageList` (`src/panels/Chat/MessageList.tsx:98`), not in the store: a row rises only when the list already had rows, the update keeps them as a prefix, and at most three rows were appended. History loading, a lane switch and a regroup all create rows after mount, so mount timing alone cannot tell a live row from a redrawn one. A store marker was rejected because it is new state no story can exercise.

## Watch out

- A consumer must not set the element's `class` reactively (`class={cond() ? a : b}`). Solid rewrites `className` wholesale and drops the entrance class mid-flight. Static `class` or `classList` is fine.
- Each mount reads layout then writes a class, so k elements mounting in one tick force k layouts. Callers today append at most three; batch the reads in a microtask before adding a consumer that mounts many at once.
- The Web Animations API was rejected: it escapes the global reduced-motion rule in `base.css`.

## Related

- [[concept_switch_cost_anatomy]]: why nothing here may add layout work to a worktree switch.
- [[component_glide]]: the other half of this ticket's motion: transitions, never keyframes.
- [[component_menu]]: an overlay, so its entrance is a plain keyframe on `[data-expanded]`.
- [[component_storybook_workshop]]: the kitchen sink's Motion section counts plays per probe.
