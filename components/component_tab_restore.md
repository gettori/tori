---
summary: Tab restore respawns shells, resumes sessions, not scrollback; focused tab is an index since ids never survive relaunch
status: current
updated: 2026-07-20
source: "Daily-driver polish: unseen badge, copy actions, tab peek, restore (personal/tori, branch `main`); Phase 2; `src/utils/tabPersist.ts`, `src/panels/Terminal/Terminal.tsx`"
---

# Terminal tab restore

**Location:** `src/utils/tabPersist.ts` (+ `tabPersist.test.ts`), `src/panels/Terminal/Terminal.tsx` (persist effect, `restoreOffer`, `acceptRestore`), `src/App.tsx` (`onboarding` prop)

Brings the terminal tab strip back after a relaunch. **Restore is respawn + resume, never scrollback replay**: shells come back fresh in their cwd, sessions come back through the normal resume path, and history stays where it already lives (the transcript viewer).

## What is stored, and what deliberately is not

Per-workspace descriptors in localStorage (`tori.terminalTabs`), keyed by the branch-unit folder so they line up with [[concept_workspace_tab_grouping]]:

- Stored: `title`, `cwd`, `kind`, `program`, `args`, and an agent tab's soft `sessionId`; plus the tab order and the focused tab per workspace.
- **Not stored: tab ids.** A restored tab gets a fresh PTY and therefore a fresh id, so the focused tab is recorded as an **index into the stored order**, not an id.
- **Not stored: command tabs.** Clone/bootstrap tabs are one-shot progress views; re-running a clone on relaunch would be destructive.
- **Not stored: buffer contents.** See the respawn-not-replay decision above.

The persist effect depends on the open set, its order, *and* `activeByWorkspace` together. Depending on the open set alone would freeze the order as it was at open time, so a reorder or a tab switch would never survive.

## Offered, never automatic

Relaunch must never silently spawn agent processes. So restore is an **offer**, made per workspace **on first visit each run** (consistent with per-workspace storage: launch lands on the restored selection's workspace, so that one gets the first offer, and visiting a second workspace later offers its own).

- The offer is a `createMemo`, not an accumulated signal — every path assigns, so the banner belongs to the workspace on screen. See [[gotcha_an_offer_banner_built_by_early_return_leaks_across_contexts]].
- One-shot per workspace either way: `offered` is a `Set<string>` the memo reads, so marking a workspace both accepts and dismisses.
- **Declining leaves the stored tabs alone.** They survive until that workspace's open set next changes, at which point the persist effect overwrites them with current truth. There is deliberately no separate declined-snapshot store.
- Suppressed while first-run onboarding is open (`onboarding` prop, fed from `App.tsx`'s `welcome()` — the same flag that suppresses the update pill), and re-evaluated when it closes because the memo reads it.

## Restore composes existing primitives

`acceptRestore` does not reimplement resuming. It walks the stored order and, per entry:

- **Agent tab with a sessionId** → look it up in one `list_sessions(workspace)` scan. Missing → skipped and counted for the notice. Resume-less adapter (empty `resume_args`) → diverted to `OPEN_TRANSCRIPT` *before* reaching resume, since resuming it would spawn a bare agent with no session. Otherwise → `focusOrResume`, which already focuses an existing tab rather than spawning a second one, so an already-live session cannot double-spawn (see [[concept_workspace_tab_grouping]]).
- **Shell, or an agent tab whose session was never attributed** → respawned as the same shell-hosted tab, re-seeded with its `init` if it had one. Its cwd is checked with `file_exists` first (which covers directories); a missing folder falls back to `homeDir()` and is counted for the notice, so a deleted folder yields a usable shell rather than a tab whose spawn fails.

Each entry records the tab id it produced into a **sparse** array indexed by stored position, so the stored active index still resolves correctly after skipped sessions leave holes.

`core:default` already grants `core:path:default`, so `homeDir()` needed no capability change.

## Key files & entry points

- `src/utils/tabPersist.ts` — pure `toStore`, `mergeStore`, `pruneStale`, `parseStore`; DOM-free and unit-tested.
- `src/panels/Terminal/Terminal.tsx` — the persist effect, the `restoreOffer` memo, `acceptRestore`.

## Connections

- Restores the tabs grouped by [[concept_workspace_tab_grouping]] and hosted by [[component_pty_host]].
- Reuses that concept's focus-or-resume path rather than duplicating it.
- Sessions are looked up through [[component_session_scanner]]; resume-less adapters come from [[component_agent_adapter_registry]].

## Related

- [[gotcha_a_persist_effect_derived_from_live_state_erases_everything_not_currently_live]]
- [[gotcha_an_offer_banner_built_by_early_return_leaks_across_contexts]]
- [[gotcha_an_always_mounted_for_gated_behind_a_show_fallback_unmounts_every_row]] — why the offer is an overlay, not a `<Show fallback>`.
- [[gotcha_stripready_waits_only_for_terminal_tabs]] - the file restore is separate, and an emptiness check needs both.
- [[gotcha_terminal_focustab_never_writes_the_pane_pick]] - why restore stays on plain `focusTab`.
- [[concept_empty_strip_auto_draft]] - what opens once both restores leave a strip empty.
