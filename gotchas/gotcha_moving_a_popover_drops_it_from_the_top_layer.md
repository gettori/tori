---
summary: moving an open popover in the DOM hides it, so show it again after every move, and a region outside a modal stays inert
status: current
updated: 2026-11-21
source: solid-2-stage-a-own-primitives plan; gettori/tickets#106; epic gettori/tickets#105; src/components/Toasts/Toasts.tsx:214
---

# Moving a popover drops it from the top layer

Do NOT move an open popover and expect it to stay up. Why: removing a node from its parent hides it and takes it out of the top layer, and a popover outside an open modal is inert even when painted above it. The toast region moves into the topmost modal, shows itself again, and finishes the entry animations of the toasts already there so they do not replay (`raise`, `src/components/Toasts/Toasts.tsx:214`).

## Related

- [[component_toasts]]
- [[component_layer]]
