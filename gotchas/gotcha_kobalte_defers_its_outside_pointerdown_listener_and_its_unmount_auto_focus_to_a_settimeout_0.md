---
summary: Kobalte defers its outside pointerdown listener and unmount auto focus to setTimeout 0, so a same tick assert fails
status: current
updated: 2026-08-12
source: "plan \"Dialog primitive on Kobalte with stories and behavior tests\" (personal/sway, branch `98-dialog-primitive`, issue #98); `@kobalte/core@0.13.13 dist/chunk/ZG3NR5OC.jsx:104`, `KEL2LLJM.jsx:176`, `src/components/Dialog/Dialog.test.tsx:12`"
---

# Kobalte defers its outside-pointerdown listener and its unmount auto-focus to a `setTimeout(0)`

Do NOT fire a backdrop click, or assert on restored focus, in the same tick as the render. Why: the dismissable layer installs `pointerdown` on the owner document from inside `window.setTimeout(..., 0)`, and the focus scope dispatches its unmount auto-focus event from another one after cleanup. A synchronous test asserts against a listener that does not exist yet and a restore that has not run, and reads as "Kobalte does not close on backdrop click" - a wrong conclusion about the library, drawn from a correct test run. Await a macrotask first. See [[component_dialog]].
