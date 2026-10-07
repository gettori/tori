---
summary: stripReady covers only terminal tabs; judging a strip empty must also await fileStripReady, whose restore probes files
status: current
updated: 2026-10-08
source: ticket gettori/tickets#17 plan, branch phase-1-block-1; src/panels/Editor/editorTabStore.ts fileStripReady; src/panels/Terminal/Terminal.tsx stripEmpty
---

# stripReady waits only for terminal tabs

Do not decide a workspace's strip is empty after `stripReady` alone; go through `stripEmpty`, which also awaits `fileStripReady`. Why: the editor restores its file tabs per workspace on its own, awaiting the unsaved stash and a `file_exists` probe per path, so `tabsByWs` is still empty for a moment after the terminal side is back and a draft would open beside the files.

`fileStripReady` starts the editor's restore or joins the one in flight, the same contract `stripReady` has, and resolves at once when no editor panel is mounted.

## Related

- [[component_tab_restore]]
- [[concept_empty_strip_auto_draft]]
