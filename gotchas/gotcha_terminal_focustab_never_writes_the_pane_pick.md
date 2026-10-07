---
summary: terminal focusTab never writes the pane's pick, so a file clicked earlier stays in front; open on purpose via bringToFront
status: current
updated: 2026-10-08
source: ticket gettori/tickets#17 plan, branch phase-1-block-1; src/panels/Terminal/Terminal.tsx bringToFront; src/layout/tabPlacement.ts activeIdInPane
---

# A terminal focusTab never writes the pane's pick

Do not open or focus a terminal tab on purpose through plain `focusTab`; use `bringToFront`, which also calls `setPaneActive` on the pane holding the tab. Why: `activeIdInPane` lets the pane's stored pick win while its kind still claims it, and a file the user clicked is still claimed, so the new session lands behind it.

`Editor.openFile` is the same fix on the file side. Restore is the one caller that must stay on `focusTab`: the pick it would overwrite is the one the user left in front.

## Related

- [[component_tab_restore]]
- [[concept_empty_strip_auto_draft]]
