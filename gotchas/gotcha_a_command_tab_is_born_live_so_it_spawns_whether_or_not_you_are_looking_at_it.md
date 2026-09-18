---
summary: a command tab defaults to live state, so opening one in a background workspace still spawns its process
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Tori's own commands as tabs in a Shells workspace\" (personal/tori, branch `standalone-terminals`, issue #166), Phase 4; `src/panels/Terminal/terminalTabStore.ts` (`defaultState`); commit `dd5c029`"
---

# A command tab is born live, so it spawns whether or not you are looking at it

`defaultState()` returns `"live"` for every kind but a chat draft, so a `kind: "command"` tab opened into a background workspace still mounts its `TerminalView` and still spawns. That is what lets a non-interactive clone run while you keep working in another branch, and it also means opening one **starts** a process rather than queueing it: there is no "wake on reveal" step to rely on for a command.
