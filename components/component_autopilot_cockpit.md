---
summary: the cockpit wires the autopilot parts: an always shown switch when enabled, a view with a time of day banner and a live ChatView, the popup
status: current
updated: 2026-09-25
source: gettori/tori#218 plan "Ticket refs that say where they are, and one way to navigate there", commit 380c7112; plan "Autopilot session and the cockpit (#205)" on branch orchestrator, issue gettori/tori#205, commits 4b309f03, 7dfdc1a9, 669596a1; restyle and feature switch on branch orchestrator for gettori/tori#207, commits c490ea9a, 21d68948, e7c57d49, cec896d9, df821076, 298de4cf, 251e53fa; src/panels/Autopilot/Cockpit.tsx, src/utils/autopilotStore.ts, src/utils/autopilotRows.ts, src/panels/Settings/panes/AutopilotPane/AutopilotPane.tsx; gettori/tori#210 on branch orchestrator, plan 'Assigned pickup: poll my issues and review requests, queue them, start on ask or auto (#210)'
---

# Autopilot cockpit

`src/panels/Autopilot/Cockpit.tsx` mounts the props only [[component_autopilot_parts]] on real data: `CockpitSwitch` in the title bar, `CockpitView` for the cockpit, `CockpitPopup` over Workspace. State lives in `src/utils/autopilotStore.ts`, the pure mapping to rows and banner words in `src/utils/autopilotRows.ts`.

## Responsibility

It shows the [[component_autopilot_runner]] and the [[component_autopilot_store]] and routes clicks back. It owns no autopilot state of its own.

- **Status** comes from `autopilot_status` once, then the `autopilot://status` event. Start and stop invoke `autopilot_start|stop` and do not apply the reply, since a late reply could overwrite a newer event; a failure shows a toast. A start or stop never moves the view.
- **Items and holds** load once from the `autopilot_state` command and are patched from each `autopilot://changed` event. The webview is not a hub subscriber, so both store publishers send that Tauri event too ([[gotcha_the_webview_is_not_a_hub_subscriber]]).
- **Activity** is the last 50 lines of `log.jsonl` (`autopilot_log`) plus live events, newest first. Log lines at or after the first live event's `ts` are dropped, so a startup race does not show a line twice.

## The feature switch

`settings.autopilot.available` is the feature, set by Settings > Autopilot > Enable autopilot. `enabled` beside it is only whether the autopilot was running, for a relaunch, and only start and stop write it. `setAutopilotAvailable(false)` saves, closes the popup, goes to Workspace and stops a running autopilot. While the feature is off there is no switch, Cmd+Shift+J and Cmd+L do nothing, and the model picker in the pane is disabled rather than hidden, so Settings search still finds it.

## The title bar

- `CockpitSwitch` sits in the title bar's flow on the right, in `.topbar-switch`, and is always shown while the feature is on. It has no start or stop of its own: the wheel on its Cockpit segment carries the state.
- In the cockpit the sidebar toggle, the history arrows and the crumb are `visibility: hidden` through `.topbar[data-view="autopilot"]`. Hidden, not unmounted: the arrows' slot is a stage host the editor owns, and the crumb's `flex: 1` is what holds the switch right.
- The popup is placed under the switch by measuring `.topbar-switch`, its right edge on the switch's, again on a resize.

## The view

- **It overlays `.body` rather than replacing it.** Unmounting the workspace would close every chat tab.
- **The banner** plays a `Horizon` scene: the hour's (`pickScene`, rechecked on a 30 s tick), or the storm when more workers are out than Settings > Chat > Warn above allows (`overLimit`, zero is no limit). `heroFor(state, calls, crew, queued, limit)` gives the eyebrow, headline and line; a needs you state keeps its words over the storm's, and an idle autopilot with workers out reads as cruising. Top right, **Set sail** starts it and **Drop anchor** stops it.
- **The conversation is a real `ChatView`**, keyed on `runner.session`, in `detach` mode: on unmount it calls `chat_detach` rather than `chat_close`, so leaving the view keeps the session. It mounts only once the runner is `idle` or `working` ([[gotcha_a_chat_view_on_a_rust_spawned_session_must_wait_for_its_first_turn]]), and whether it is shown is a memo, so a turn flipping idle and working does not remount it ([[gotcha_a_remounted_chat_view_on_a_shared_tab_id_is_detached_by_the_old_one]]). After a second death it shows the dead session read only (`started=false`).
- **`cockpit` on the ChatView** hides the status strip and the pickers, since the picks live in Settings; puts the wheel beside each reply (`replyMark` on `MessageList`); draws prompts in violet; and heads the ask cards with Captain's call. The rules are `.chat[data-cockpit]` in `Chat.module.css`.
- **In flight and queue** come from items (`running` and `waiting_on_you` in flight, `queued` queued, oldest first, then `proposed` items marked "proposed" with no "after", since they wait for a go typed in the chat). The banner's queued count leaves proposed rows out. A card reads the item's `title`, else "Ship in <project>"; worker log, diff and progress are empty until something records them.

## Ticket refs

Every ref is the row's `reference`, drawn by `TicketLink` in `ShellParts.tsx`: `#N` opens the forge page through the opener plugin, and the place opens it in Tori through `NAVIGATE` ([[concept_in_app_navigation]]). The crew card puts the number in its ring and the place on its branch line; queue, "after", activity and decision cards show both. A decision card shows the item's issue and, once there is one, its PR beside it, rather than the approval's PR number. Watch and the popup's in flight rows navigate to the worker; in a popup row the number stands beside the button, since a link cannot sit inside one. A live change keeps a row's `session_live` and `worktree_gone` from the last full read (`applyItem`), and a logged activity line takes the current row's reference by item id (`ticketOf`).

## The popup

- A light `Thread` from `chat_history` (Tori notes skipped, last six messages), its replies drawn through `Markdown` so the refs the autopilot pastes are links, reread on open and on each status change, and a `Composer` that goes through `chat_steer` while working and `chat_send` otherwise.
- **Decisions render here only.** The view's `ChatView` already draws the same asks as its own cards, so the view gets none. A decision is every hold (an ask with an `item`) plus any ask shown in the autopilot's session. Approve and Dismiss answer an approval `Approve` or `Reject` through `answerAsk`; a question, Edit and Reply open the view, where the card takes words.
- Escape, an outside pointerdown and any `NAVIGATE` close it; Cmd+L toggles it and Cmd+Shift+J the view (`autopilot-popup`, `autopilot-view` in `commands.ts`).

## Related

- [[component_autopilot_parts]]: what it draws with
- [[component_autopilot_runner]]: the session behind it
- [[component_autopilot_store]]: items, contracts and the log
- [[component_chat_host]]: `chat_detach` and `chat_waiting`
- [[component_app_socket]]: the asks and holds decisions come from
- [[concept_tori_notes]]: the brief, wakes and resumes in its chat
- [[adr_assigned_pickup_rides_the_forge_poll_tick]]: where proposed rows come from
