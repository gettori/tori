---
summary: do not rely on requestIdleCallback in Tori's WebView, WebKit does not ship it; wait for a frame then a zero timeout
status: current
updated: 2026-10-05
source: plan "Move syntax highlighting off the main thread, then move whatever else measures slow" (personal/tori, branch `off-the-main-thread`), ticket gettori/tickets#7, phase mermaid-idle; `src/components/Diagram/Diagram.tsx` `idle`; commit af41acea
---

# WebKit has no `requestIdleCallback`

Do not call `requestIdleCallback` unguarded in Tori's WebView: WebKit does not ship it, so idle work has to fall back to `requestAnimationFrame` followed by a zero `setTimeout`, which runs after the frame has painted. Why: the API is Chromium and Firefox only. `Diagram.tsx`'s `idle()` feature-detects it and uses the fallback, and queues mermaid renders so one runs per slot.

## Related

- [[component_markdown_preview]]: where diagrams are drawn in a preview
