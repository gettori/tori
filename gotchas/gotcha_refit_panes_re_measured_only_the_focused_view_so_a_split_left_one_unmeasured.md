---
summary: REFIT_PANES re-measured only the focused view on reveal, so a split's unfocused pane stuck at placeholder height
status: current
updated: 2026-08-20
source: "plan \"The reveal path: verify the mismatch switch, then decide what it costs\" (phase 2, personal/tori, branch `unified-tab-bar`), `src/panels/Editor/CodeEditor.tsx`, commit be27425, [[component_cm6_editor]], _2026-08-20_"
---

# REFIT_PANES re-measured only the focused view, so a split left one unmeasured

Do NOT re-measure "the" editor view on a reveal; loop every pane's. Why: a split builds a view in the pane that did **not** take focus, and a view that never measures never renders, keeping CodeMirror's placeholder height. Measured at the split, that view reported a `scrollHeight` of 33554432 (2^25) before the loop and a real 4628 after it. This is a rendering defect a user sees, and it was invisible until a trace probe enumerated every editor stage host instead of the first one.
