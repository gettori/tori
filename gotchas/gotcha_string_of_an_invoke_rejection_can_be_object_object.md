---
summary: forge and issue commands reject with a ForgeErrorDto object, so String(e) shows [object Object]; read .message
status: current
updated: 2026-09-24
source: "gettori/tori#202 on branch orchestrator; commits f8a61936, 83aa08f4, 982c9bed; src/utils/issues.ts errorText; src/panels/LeftSidebar/LeftSidebar.tsx confirmAddBranch"
---

# String of an invoke rejection can be [object Object]

Do not `String(e)` an `invoke` rejection from a forge or issue command: those return `Result<_, ForgeErrorDto>`, so the promise rejects with `{kind, message, ...}`, not a string. Why: most Tauri commands reject with a plain `String`, so a catch written for them prints `[object Object]` the first time a DTO flows through; use `errorText` (`src/utils/issues.ts`), which reads `message` and falls back to `String(e)`.

## Related

- [[component_issue_source]]
- [[component_forge_client]]
