---
summary: autofocus is honoured at parse time, not when Solid's Show inserts the node, so a revealed input never gets the caret
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 12 (personal/sway, branch `wave-6`); `src/panels/Editor/SearchPanel.tsx`; commit 98b038b"
---

# `autofocus` on an input a `Show` inserts is not honoured

Do NOT rely on the `autofocus` attribute for an input that appears through a `Show`. It is honoured at parse time, not when Solid inserts the node, so clicking the control that reveals the input leaves the caret nowhere. Use a ref plus `requestAnimationFrame`, the same deferral the Search panel's own focus effect already uses. Why: it works in the JSX and fails only once the element is conditional, so it survives review.
