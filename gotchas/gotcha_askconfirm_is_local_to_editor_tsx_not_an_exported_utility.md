---
summary: askConfirm is a closure inside Editor.tsx over its own dialog signal, a child must take it as a prop, not import it
status: current
updated: 2026-08-01
source: "Search panel v2 (branch `wave-1-2`); Phase 4; `src/panels/Editor/Editor.tsx:252`; PR #81"
---

# `askConfirm` is local to Editor.tsx, not an exported utility

Don't try to import `askConfirm` into a child of the editor: it is a closure at `Editor.tsx:252` over a `confirmReq` signal that renders the dialog, not a shared helper. Why: the promise it returns is resolved by that component's own dialog, so a child needing confirmation takes it as a prop (`SearchPanel`'s `confirm`). That also keeps the child testable with a stub instead of a mounted dialog.
