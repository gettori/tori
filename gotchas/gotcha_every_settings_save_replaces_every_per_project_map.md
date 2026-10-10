---
summary: every saveSettings hands back fresh objects, so an effect keyed on settings.x[path] by reference refires on any unrelated save
status: current
updated: 2026-10-10
source: plan "Project settings tab" (branch phase-1-block-2, gettori/tickets#81); src/panels/ProjectSettings/AgentsSection.tsx, src/panels/ProjectSettings/ChecksSection.tsx; commit 09af6480
---

# Every settings save replaces every per-project map

Do not reset a draft from an effect that tracks `settings.projectAgents[path]` or `settings.verification.commands[path]` directly: key it on the value's content (`createMemo` to a string) instead. Why: `saveSettings` and the watcher echo set the store from a parsed file, so every map is a new object, and a chat remembering its model mid-session would wipe whatever the user was typing.

## Related

- [[component_project_settings_dialog]]
- [[component_settings_store]]
