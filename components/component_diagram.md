---
summary: mermaid diagrams take every colour as the text mixed into the ground at fixed strengths, seeded per render from tokens
status: current
updated: 2026-11-17
source: plan "Visual polish pass with a Storybook kitchen sink" (personal/tori, branch ui-rework), phase 10 and follow-ups; src/utils/mermaidEngine.ts:26; src/components/Diagram/Diagram.module.css:28; commits 0a524bbd, f3fce4b5
---

# Diagram and the mermaid engine

`src/components/Diagram/Diagram.tsx` draws one mermaid fence; `src/utils/mermaidEngine.ts` is the lazily imported half that seeds and calls mermaid.

## Responsibility

- `Diagram` decides when to draw (near the screen, one render per idle slot, redrawn on a theme switch once visible) and shows the source while a drawing is pending or the fence does not parse.
- `mermaidEngine` decides how a diagram looks. It re-seeds mermaid before every render, so a theme switch repaints diagrams like everything else.
- Neither sanitises: mermaid's `securityLevel: "strict"` DOMPurify pass is what lets the SVG reach `innerHTML`.

## The colour ladder

Every fill, frame and line is the theme's text (`--fg-default`) mixed into the diagram's ground (`--canvas-default`) at a fixed strength, through `mix()` from `src/theme/roles.ts`, so one ladder holds on every palette and every diagram kind (`LADDER`, line 26): fill 3, frame 20, line 50, subgraph title 60, edge label text 60, arrowhead 85, note and activation fill 5. Sequence actors, ER rows and pie slices (10 to 45 in steps of 7, line 60, capped so the ink stays readable on the strongest) sit on the same ladder. When a theme hands over a non-hex value the ladder is skipped and the plain token seeds stand (line 79).

- Mermaid has no seed for arrowheads, edge label text or stroke width, so those go through `themeCSS` (line 87). Mermaid scopes it under the diagram's id, so it outranks the rules mermaid writes without `!important`.
- Text is 13px through two settings: `themeVariables.fontSize`, and the top-level `fontSize` (line 122), which the sequence renderer's `setConf` copies over its own actor, message and note sizes. Setting only the sequence block does nothing.
- Mermaid 11's ER renderer reads `rowOdd`/`rowEven`, not `attributeBackgroundColor*`; leave either out and its first attribute row paints white on dark.

## Geometry, in the module CSS

- A dot grid on the frame (1px `--border-strong` dots every 22px times `--ui-scale`, line 12). The SVG is clamped to `max-width: 100%`, so the box never scrolls sideways under the dots.
- Rect nodes and subgraphs round to `--tori-radius-md` through CSS `rx`/`ry` (line 28), which WebKit and Chrome both honour. Diamonds and the other drawn shapes are polygons and paths, with no corner to round.
- Edge labels are hairline chips: the label's `foreignObject` is sized to the bare text, so it is set `overflow: visible` and the `<p>` gets `padding: 0 6px` paid back by `margin: 0 -6px !important` (`!important` beats mermaid's id-scoped `p { margin: 0 }`). A transform or relative position would be simpler and is wrong, see [[gotcha_webkit_paints_positioned_content_in_a_foreignobject_at_the_svgs_corner]].

## Rejected

Adopting an outside renderer with its own parser and an elkjs layout (its look is what the ladder copies): two renderers with two looks, a new layout dependency, a sanitizer review for SVG built as a string, and syntax gaps, with Excalidraw arriving for flowcharts next.

## Related

- [[gotcha_webkit_has_no_requestidlecallback]]: why the render queue waits a frame then a zero timeout.
- [[gotcha_an_inline_svg_style_block_is_global]]: mermaid's own style block is id-scoped for this reason.
- [[component_theme_engine]]: where `mix()` and the token values come from.
- [[component_storybook_workshop]]: the kitchen sink's Diagram section draws one diagram per kind.
