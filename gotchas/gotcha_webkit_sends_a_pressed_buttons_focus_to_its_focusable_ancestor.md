---
summary: WebKit moves focus from a clicked button to its focusable ancestor, so a focus outside check can close a new menu
status: current
updated: 2026-11-21
source: solid-2-stage-a-own-primitives plan; gettori/tickets#106; epic gettori/tickets#105; src/lib/layer.ts:101
---

# WebKit sends a pressed button's focus to its focusable ancestor

Do NOT read a `focusin` during the press that opened a layer as focus leaving it. Why: WebKit does not focus a clicked button and moves focus to the nearest focusable ancestor instead, so a menu opened from a button inside a dialog saw focus land on the dialog and closed at once. The layer ignores `focusin` until that press is released (`noteOpeningPress`, `src/lib/layer.ts:101`).

## Related

- [[component_layer]]
- [[gotcha_webkit_fires_no_blur_when_a_focused_element_is_removed]]
