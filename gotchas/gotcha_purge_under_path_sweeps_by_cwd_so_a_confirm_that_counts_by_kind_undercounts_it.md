---
summary: PURGE_UNDER_PATH closes every tab under the doomed cwd, but the delete confirm excludes command tabs as transient
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Sway's own commands as tabs in a Shells workspace\" (personal/sway, branch `standalone-terminals`, issue #166), Phase 4; `src/panels/Terminal/Terminal.tsx:838`, `src/panels/LeftSidebar/LeftSidebar.tsx:678`; commit `dd5c029`"
---

# `PURGE_UNDER_PATH` sweeps by cwd, so a confirm that counts by kind undercounts it

Do NOT filter a destructive confirm's live-tab count by tab kind when the purge behind it filters by path. `Terminal.tsx`'s `PURGE_UNDER_PATH` handler closes every tab whose **cwd** is under the doomed folder, but the space and project delete confirms excluded `kind === "command"` as transient, so a clone running into that space was killed by a dialog that had just said nothing was running there. Why: the two filters answer different questions and nothing ties them together.
