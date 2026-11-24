---
summary: showModal focuses the first control and fires its handlers; autofocus did not stop it, inert while opening does
status: current
updated: 2026-11-21
source: solid-2-stage-a-own-primitives plan; gettori/tickets#106; epic gettori/tickets#105; src/components/Dialog/Dialog.tsx:74
---

# showModal focuses the first control unless the dialog is inert

Do NOT rely on `autofocus` on the `<dialog>` to keep `showModal` off the first control: in Chromium it still focused it and fired that control's focus handlers, which can open a tooltip. Why: the dialog focusing steps pick a control before our own `initialFocus` runs. Set `panel.inert = true` around `showModal()`, then focus the target (`src/components/Dialog/Dialog.tsx:74`).

## Related

- [[component_dialog]]
- [[component_layer]]
