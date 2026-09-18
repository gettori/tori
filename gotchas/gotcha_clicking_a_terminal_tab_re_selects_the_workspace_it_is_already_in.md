---
summary: clicking a terminal tab writes a fresh Selection even for the worktree already active, re running 8 to 15 effects
status: current
updated: 2026-08-20
source: "plan \"The reveal path: verify the mismatch switch, then decide what it costs\" (phase 4, personal/tori, branch `unified-tab-bar`), `src/panels/LeftSidebar/LeftSidebar.tsx`, commit c2b6526, _2026-08-20_"
---

# Clicking a terminal tab re-selects the workspace it is already in

Do NOT assume a tab click is cheap because it changes no data. Why: `selectTab` emits `TERMINAL_TAB_FOCUSED`, the sidebar answers with `focusFromTerminalTab` -> `selectBranchByFolder` -> `selectUnit` -> `onSelect`, and that writes a **fresh** `Selection` object for the worktree already selected. `selected` is a plain signal, so every effect keyed on the root re-runs: 8 to 15 invokes per click (git status, branches, ahead/behind, the settings overlay, a DAP sweep, an fs-watcher restart, three tree listings), landing between the two frames the paint endpoint measures. Guarding the write is not safe as it stands: two ways of skipping it each intermittently lost terminal tabs from the strip, so something on that path is load-bearing for tab placement. See [[lesson_a_redundant_write_was_load_bearing]].
