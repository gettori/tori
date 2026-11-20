---
summary: scripts/check.sh all rewrites tori-push's permissions schema.json in serde's layout after format passed; the JSON is unchanged
status: current
updated: 2026-11-20
source: "plan \"Cmd+K navigator\" (personal/tori, branch `cmdk-improvements`), Phase 14; `scripts/check.sh`, `mobile/src-tauri/plugins/tori-push/permissions/schemas/schema.json`"
---

# check.sh all rewrites the tori-push permission schema

Do NOT commit `mobile/src-tauri/plugins/tori-push/permissions/schemas/schema.json` after a full check: the mobile crate check regenerates it in serde's expanded layout after the format stage has already passed, so it shows up modified with the same JSON. Compare the parsed JSON against HEAD and `git checkout --` it. Why: the Tauri plugin build writes the schema on every build, and the committed copy is in the formatter's compact layout.

## Related

- [[component_check_script]] the script whose stages produce this
