---
summary: the cockpit wires the autopilot parts: title bar switch, overlay view with a live ChatView, popup with decisions, Settings pane
status: current
updated: 2026-09-24
source: plan "Autopilot session and the cockpit (#205)" on branch orchestrator, issue gettori/tori#205; commits 4b309f03, 7dfdc1a9, 669596a1; src/panels/Autopilot/Cockpit.tsx, src/utils/autopilotStore.ts, src/utils/autopilotRows.ts, src/panels/Settings/panes/AutopilotPane/AutopilotPane.tsx
---

# Autopilot cockpit

`src/panels/Autopilot/Cockpit.tsx` mounts the props only [[component_autopilot_parts]] on real data: `CockpitSwitch` in the title bar, `CockpitView` for the Autopilot view, `CockpitPopup` over Workspace. State lives in `src/utils/autopilotStore.ts`, the pure mapping to rows in `src/utils/autopilotRows.ts`.

## Responsibility

It shows the [[component_autopilot_runner]] and the [[component_autopilot_store]] and routes clicks back. It owns no autopilot state of its own.

- **Status** comes from `autopilot_status` once, then the `autopilot://status` event. Start and stop invoke `autopilot_start|stop` and do not apply the reply, since a late reply could overwrite a newer event; a failure shows a toast.
- **Items and holds** load once from the `autopilot_state` command and are patched from each `autopilot://changed` event. The webview is not a hub subscriber, so both store publishers send that Tauri event too ([[gotcha_the_webview_is_not_a_hub_subscriber]]).
- **Activity** is the last 50 lines of `log.jsonl` (`autopilot_log`) plus live events, newest first. Log lines at or after the first live event's `ts` are dropped, so a startup race does not show a line twice.

## The view

- **It overlays `.body` rather than replacing it.** Unmounting the workspace would close every chat tab. `.body` is `position: relative` for it.
- **The conversation is a real `ChatView`**, keyed on `runner.session`, in `detach` mode: on unmount it calls `chat_detach` rather than `chat_close`, so leaving the view keeps the session. It mounts only once the runner is `idle` or `working` ([[gotcha_a_chat_view_on_a_rust_spawned_session_must_wait_for_its_first_turn]]). After a second death it shows the dead session read only (`started=false`), which stands in for View log.
- **In flight and queue** come from items (`running` and `waiting_on_you` in flight, `queued` queued, oldest first). Items carry no title, so a card reads "Ship in <project>" or "Review in <project>"; a queued row's `after` is the item ahead of it. Worker log, diff and progress are empty until something records them.

## The popup

- A light `Thread` from `chat_history` (brief skipped, last six messages), reread on open and on each status change, and a `Composer` that goes through `chat_steer` while working and `chat_send` otherwise.
- **Decisions render here only.** The view's `ChatView` already draws the same asks as its own cards, so the view gets none. A decision is every hold (an ask with an `item`) plus any ask shown in the autopilot's session. Approve and Dismiss answer an approval `Approve` or `Reject` through `answerAsk`, the call the chat's card makes; a question, Edit and Reply open the view, where the card takes words. Age is the hold's `asked_at`.
- Escape and an outside pointerdown close it; Cmd+L toggles it and Cmd+Shift+J the view (`autopilot-popup`, `autopilot-view` in `commands.ts`).

## Settings > Autopilot

A tab after Chat, marked with the wheel (`WheelGlyph`). The switch reads `runner().state`, never `settings.autopilot.enabled`, and invokes start or stop. One `ModelPicker` row carries agent, account, model and effort, fed by `paletteProviders` as the chat draft is, probing the picked agent on mount. A model switch keeps the effort only when the new model offers that level. Picks apply at the next start.

## Related

- [[component_autopilot_parts]]: what it draws with
- [[component_autopilot_runner]]: the session behind it
- [[component_autopilot_store]]: items, contracts and the log
- [[component_chat_host]]: `chat_detach`
- [[component_app_socket]]: the asks and holds decisions come from
