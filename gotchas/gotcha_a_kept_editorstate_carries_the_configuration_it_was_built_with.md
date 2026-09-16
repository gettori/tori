---
summary: a stashed EditorState handed to a second mount still runs the first mount's extensions unless reconfigured
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 11 (personal/sway, branch `wave-6`); `src/panels/Editor/searchResultsStore.ts`; commit 48af914"
---

# A kept `EditorState` carries the configuration it was built with

Do NOT hand a stashed `EditorState` to a second mount without `StateEffect.reconfigure`. A state carries its extensions, so the new view runs the *first* mount's ones: closures over a destroyed view return early and messages go to signals nothing renders, which reads as a component that silently does nothing on the second visit. Reconfiguring keeps the document, the selection and the undo history. Why: the obvious test (the edits are still there) passes against the broken code, because only the rules stop working.
