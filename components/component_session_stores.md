---
summary: two module level stores outlive any component, holding the sessions map, tail states and tray plus badge effects
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown; pi and opencode are removed (branch `navigation`, phases 3-4); commits a713a26, 61eb767
---

# Session stores (sessionStore + sessionActivity)

**Location:** `src/utils/sessionStore.ts`, `src/utils/sessionActivity.ts`

Two module-level stores holding everything the app knows about sessions and what they are doing. `sessionStore` owns the folder→`SessionMeta[]` map, the per-folder historical flag, and the scan observers. `sessionActivity` owns the probes, PTY activity, tail states, the composed status lists, and the tray / dock-badge / notification effects. Both are module-level rather than component state because what reads them is not the sidebar and should not have to mount one.

## Responsibilities

- **Owns** the folder→sessions map, per-folder historical flags, liveness probes, PTY activity, transcript tail states, and the two composed status lists (`liveSessionStatuses`, `sessionStatus`).
- **Owns** the tray, dock badge, and needs-you notification effects, in one module-level `createRoot` — the honest shape for state whose whole point is to outlive any component. The tray must keep tracking whether or not the sidebar is mounted, and there is nothing to dispose short of the app closing.
- **Does not** decide which folders matter. It cannot: that needs the config. `LeftSidebar` keeps one effect handing it `[every branch-unit in the active space, every live tab's workspace]`.
- **Does not** ask for the historical verdict during a listing. `folder_historical` auto-adopts and writes `adopted.json`, so `checkHistorical` is a separate, deliberate call made only where the Historical section is about to render.

## Key files & entry points

- `src/utils/sessionStore.ts:78` — `fetchSessions`, the single-folder entry point
- `src/utils/sessionStore.ts:91` — `trackFolders`, which lists only folders never seen, guarded by an `inFlight` set against double-listing
- `src/utils/sessionStore.ts:57` — `onFolderScan`, announcing `{folder, list}[]` rather than "the map changed"
- `src/utils/sessionStore.ts:142` — `checkHistorical`, the call that writes to disk
- `src/utils/sessionActivity.ts:102` — `probeBatch`, one `sessions_running` IPC for many ids
- `src/utils/sessionActivity.ts` — `liveSessionStatuses` (tabs + chats) and `sessionStatus(id)` (every tier)

## Connections

- Fed by [[component_session_scanner]] — `list_sessions` is what the store caches
- Read by [[component_history_dropdown]] — the panel owns almost nothing and reads both stores
- Implements [[concept_session_certainty_tiers]] — the store is where the three tiers are composed
- Drives [[concept_needs_you_floor]] — tail states and the tray/badge effects live here

## Design notes worth keeping

**The map accumulates and is never pruned.** A tab outlives the space it was opened in, so dropping a folder when the active space changes would starve the needs-you pipeline for an agent still running in the space you navigated away from.

**Four inputs are pushed in rather than reached for:** the live tab set, folderPath→(space, project), the current selection, and window focus. Everything else the store derives. This is what makes it testable without mounting a component.

**Observers hang off scans, not off the map.** `onFolderScan` announces which folders rescanned, because both consumers need that granularity: stamp pruning may only act inside a folder that actually rescanned, and the detached sweep wants exactly the sessions that scan turned up. A *failed* scan is deliberately not announced and keeps its stale list.

**There is no published copy of the composed list.** An earlier version republished a snapshot of `sessionStatus`; it existed only because the composition lived in a component, and a copy is always a tick behind its source. Consumers read the memo directly.

## Related

- [[lesson_pure_core_for_global_stores]] — the shape this follows
- [[gotcha_a_persist_effect_derived_from_live_state_erases_everything_not_currently_live]] — why a failed scan keeps its stale list
- [[gotcha_a_window_listener_registered_in_an_async_onmount_can_miss_a_startup_event]] — the race the sidebar's drive effect sits next to
