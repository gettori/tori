---
summary: a listener registered after the first await in onMount misses anything fired first, a missed event never redelivers
status: current
updated: 2026-08-02
source: "Editor wave 1: close out the fundamentals (personal/tori, branch `wave-1-4`); Phases 1 and 3; `src/panels/Editor/CodeEditor.tsx:553`, `src/panels/Editor/Editor.tsx` (onMount), `src/panels/Editor/editorCommands.test.tsx`; commits ca440df, bd9567c"
---

# A listener registered after an `await` in `onMount` misses what fires in that window

Don't register a window listener or an event subscription after the first `await` in `onMount` unless nothing can fire before it. Why: unlike a signal, an event that missed its listener is never redelivered, so the component is permanently wrong rather than briefly late. This has now bitten twice in one ticket. `CodeEditor` subscribed to `onLspChange` after `await listen("fs://changed")`, so a language client that finished starting inside that window fired with no subscriber and the buffer held no LSP plugin for good, which is bug #13 in a narrower form. `Editor` registers `OPEN_IN_EDITOR` after two awaits, which a test only found because it drove the event at a still-mounting pane and nothing happened. Register the synchronous subscriptions first, before any await and before any opening swap; if a test must fire at a freshly mounted component, wait on the *last* thing `onMount` does (`onCloseRequested` here) rather than on the first sign of life.
