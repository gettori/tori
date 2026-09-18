---
summary: Kobalte's modal close focuses triggerRef on exit, undefined for any dialog not opened from a Dialog.Trigger
status: current
updated: 2026-08-12
source: "plan \"Dialog primitive on Kobalte with stories and behavior tests\" (personal/tori, branch `98-dialog-primitive`, issue #98); `@kobalte/core@0.13.13 dist/chunk/V25KEN4T.jsx:143-156`, `src/components/Dialog/Dialog.tsx:56-79`"
---

# Kobalte's modal close restores focus to a `Trigger` you may not have

Do NOT rely on Kobalte to return focus where it was when a modal dialog closes. Why: in modal mode `onCloseAutoFocus` calls `e.preventDefault()` (killing the focus scope's own restore) and then focuses `context.triggerRef()`, which is `undefined` for any dialog opened from app state rather than from a `Dialog.Trigger` - every dialog in Tori. `focusWithoutScrolling(undefined)` is a no-op, so focus lands nowhere and the next keystroke goes to `<body>` instead of back to the terminal. The wrapper captures `document.activeElement` in `onOpenAutoFocus` (dispatched *before* anything is focused) and restores it itself. See [[component_dialog]].
