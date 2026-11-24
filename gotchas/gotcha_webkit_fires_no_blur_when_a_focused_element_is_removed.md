---
summary: WebKit fires no blur when a focused element is removed and Chromium does, so a removal handler cannot assume either
status: current
updated: 2026-11-21
source: solid-2-stage-a-own-primitives plan; gettori/tickets#106; epic gettori/tickets#105; src/components/Tab/Tabs.tsx:86
---

# WebKit fires no blur when a focused element is removed

Do NOT assume a blur event follows removing the focused element. Why: Chromium fires it and WebKit does not, so focus state kept from blur goes stale in one engine only. `Tabs` restores focus after a focused tab is removed only when no blur fired, which matches main in both engines (`src/components/Tab/Tabs.tsx:86`).

## Related

- [[component_tab]]
- [[gotcha_webkit_sends_a_pressed_buttons_focus_to_its_focusable_ancestor]]
