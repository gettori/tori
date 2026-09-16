---
summary: reading layout in a codemirror view plugin's constructor or update throws, leaving an orphaned overlay on a dead plugin
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 8 (personal/sway, branch `wave-6`); `src/panels/Editor/stickyScroll.ts:158`; commit 2185971"
---

# Reading the editor layout during a CM6 update throws

Do NOT read layout (`posAtCoords`, `coordsAtPos`, `contentDOM` geometry) in a view plugin's constructor or its `update`, both of which run inside an update. CodeMirror throws `Reading the editor layout isn't allowed during an update`, and the throw leaves whatever the plugin already appended to the DOM attached to a dead plugin, so a later reconfigure finds an orphaned overlay pinned over the file. Defer through `view.requestMeasure({ key: this, read, write })`, which also collapses a flick of the scroll wheel into one read. Why: the crash names the rule but not the second symptom, and the orphan is what a test actually sees.
