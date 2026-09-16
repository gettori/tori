---
summary: giving CodeMirror a full document ChangeSet maps every position to the change's end, breaking rename and format on save
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/sway, branch `wave-4`); Phases 3, 6; `src/panels/Editor/docDiff.ts`; commits c5dac84, cbb4497"
---

# A whole-document replace collapses every position map

Do NOT hand CodeMirror a full-document `ChangeSet` when anything downstream maps positions through it. A whole-document replace maps *every* position in the file to the change's end, so a rename spanning a file an agent rewrote mid-operation aims every edit at offset 0, and a format-on-save moves the caret off whatever line it was on, on every save. Trim the common prefix and suffix instead so everything outside the region that actually moved maps to itself — guarding surrogate pairs, since the halves are separate code units but one character and splitting one produces a document CodeMirror cannot hold. `docDiff.ts` is the shared implementation; it has two callers with two unrelated reasons for wanting it.
