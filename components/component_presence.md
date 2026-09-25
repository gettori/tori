---
summary: OS notification, tray and dock badge read one shared rising edge tracker so they cannot disagree on needs you
status: current
updated: 2026-09-25
source: Adapter registry, pulse, presence, checkpoints (personal/tori, branch `topbar`); Phase 3; `src-tauri/src/presence.rs`, `src/utils/presence.ts`; plan "Autopilot hard lock, release on stop, reconcile on start (#209)" on branch orchestrator, issue gettori/tori#209; commits 28f747ed, 32def50a, f29dfcbd
---

# Presence (OS notification, tray, dock badge)

**Location:** `src-tauri/src/presence.rs`, `src/utils/presence.ts`, `src/panels/LeftSidebar/LeftSidebar.tsx` (wiring)

Presence takes [[concept_needs_you_floor]]'s per-session dot state outside the window: an OS notification when a session first blocks, a menu-bar tray with running/needs-you counts and per-session focus-on-click entries, and a dock badge counting unattended-blocked sessions. All three read from one shared rising-edge tracker so they can't independently drift on what "just blocked" or "still needs you" means.

## Responsibilities

- **`presence.ts`'s state machine** (`stepPresence`/`markAttended`): pure, fully unit-tested (9 tests, no DOM/Solid), the same "extract the decision into pure functions" pattern [[concept_needs_you_floor]]'s `note_output`/`check_quiet` used. Fires exactly once on a session's quiet+blocked-candidate **rising edge** — never on a re-render while it stays needs-you — and tracks a per-session **attended** flag: cleared by a rising edge (a fresh block is always unattended), set when that session's tab is focused while unattended. `liveCounts`/`unattendedNeedsYouCount`/`shouldSuppressNotification` are derived, also pure.
- **OS notification**: fires on the tracked rising edge, suppressed when the app is focused and that session's tab is already the active one (you're already looking at it). A new needs-you transition re-arms a previously attended session's notification.
- **Tray** (`presence.rs`'s `update_tray`/`TrayEntry`, built via `build_tray` in `lib.rs`'s `.setup()`): running/needs-you counts with per-session menu entries; a menu click emits `tray://focus-session` for the frontend to focus that tab. `build_tray`'s failure is handled the same non-fatal way as the askpass bridge ([[component_askpass]]) — log + continue, no tray rather than no app — rather than a bare `?` that would have crashed the whole app on a platform tray quirk or missing icon.
- **Dock badge** (`presence.rs`'s `set_badge_count`, `Window::set_badge_count(Option<i64>)`): count of sessions in an unattended-needs-you state, decremented as each is attended, re-armed by a new transition.
- **New dependencies grounded in current docs before use** (per this repo's `/gg` convention of checking third-party API surfaces rather than guessing): `tauri-plugin-notification`, `tauri`'s built-in `tray-icon` feature, and the built-in `Window::set_badge_count` — confirmed against `v2.tauri.app`/`docs.rs` before writing any code against them.

## Key files & entry points

- `src-tauri/src/presence.rs:16` — `TrayState`/`TrayEntry`.
- `src-tauri/src/presence.rs:30` — `update_tray`.
- `src-tauri/src/presence.rs:80` — `set_badge_count`.
- `src/utils/presence.ts` — the state machine, `notifyNeedsYou`, `onNeedsYouNotificationClick`.
- `src/panels/LeftSidebar/LeftSidebar.tsx` — `liveSessionDots` (the shared per-session dot+metadata memo all three surfaces read), `notePresence` wiring.

## Connections

- Consumes [[concept_needs_you_floor]]'s composed dot state (`sessionDot`) via `LeftSidebar.tsx`'s `liveSessionDots` memo.
- Governed by [[component_askpass]]'s non-fatal-startup precedent — `build_tray`'s failure handling mirrors it directly.

Chat sessions contribute to the same tray count, badge and notifications alongside the existing PTY contributors, with PTY behaviour unchanged. A chat blocked on an approval **in the tab you are looking at** deliberately raises no OS notification, which is why `LiveChat` carries `visible`: the sidebar selection cannot answer that question, since a chat mints its session id before any transcript exists and selecting its tab usually resolves only as far as its branch.

A worker (a chat another session spawned, `LiveChat.spawner`) raises no OS notification while its spawner can relay the question: the spawning chat is still live, or the autopilot is on (`relayed` in `src/utils/sessionActivity.ts`). A worker the autopilot left behind when it stopped notifies like any session. The autopilot's on state is fed in through `noteAutopilotOn` ([[gotcha_importing_autopilotstore_into_sessionactivity_breaks_its_suite]]).

## Related

- [[component_chat_panel]] - the chat-side contributor.
- [[concept_needs_you_floor]] — the signal presence reacts to.
- [[component_autopilot_runner]]: the autopilot whose workers stay quiet while it runs.
- A residual uncertainty (flagged, not hidden): whether a plain notification-body click (no registered action button) reaches the notification plugin's `onAction` callback wasn't fully confirmed from docs alone; implemented on the reasonable assumption it does, not yet confirmed by an actual click in the running app.
