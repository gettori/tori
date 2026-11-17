---
summary: position relative or a transform inside an SVG foreignObject paints at the SVG's corner in WebKit; shift with margins instead
status: current
updated: 2026-11-17
source: plan "Visual polish pass with a Storybook kitchen sink" (personal/tori, branch ui-rework), the diagram label chips; src/components/Diagram/Diagram.module.css:40; commit f3fce4b5
---

# WebKit paints positioned foreignObject content at the SVG's corner

Do NOT nudge HTML inside an SVG `<foreignObject>` with `position: relative`, `left`/`top` or a `transform`, and do not trust Chrome to tell you it worked. Why: WebKit gives such an element its own layer and paints it against the SVG's origin, ignoring the transforms on the groups around it, so a mermaid edge label jumped to the diagram's top-left corner in WKWebView while Chrome drew it in place and measured identical rects in both. Shift with margins, which stay in normal flow (the label chip pays its padding back with a negative margin), and check the real paint in WebKit, not a bounding box.

## Related

- [[component_diagram]]: where it bit, and the margin recipe.
- [[gotcha_caretpositionfrompoint_does_not_exist_in_wkwebview]]: another case of Chrome passing what the app's engine does differently.
