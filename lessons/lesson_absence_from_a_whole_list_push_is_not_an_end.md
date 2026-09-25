---
summary: a whole list push clears what a reload lost, but a missing entry is not proof the child ended; ask the host that owns it
status: current
updated: 2026-09-26
source: gettori/tori#199 on branch orchestrator; commit 25551855; src-tauri/src/rpc/states.rs (SessionStates::replace); src-tauri/src/rpc/mod.rs (rpc_session_states, now rpc_session_facts); src-tauri/src/rpc/dots.rs (Dots::replace, gettori/tori#212)
---

# Absence from a whole list push is not an end

## What happened

The webview pushes its whole list of live session states, and `SessionStates::replace` read any id missing from it as ended. That was harmless while it only produced `state: ended`. Once it became `session.ended`, a webview reload would have told every watcher that every running session died: after a reload the list fills in gradually, and tab restore runs per workspace on first visit, which can be an hour later. The plan's fix, holding the push until restore settles, could not work, because there is no single moment when it has.

## What we learned

A whole list is the right shape for clearing entries a reload lost, and the wrong evidence for an end. The webview's list says what the webview is showing, not what is running. The owner of the child is the one that knows.

## What to do differently

When a snapshot from one side decides a lifecycle fact about something another side owns, check the owner before announcing it. Here the push carries `source` and the PTY `tab`, and `replace` takes an `alive` check: `ChatHost::live_sessions` for a chat, `PtyState::live_ids` by tab for a PTY. An absent session that is still alive is kept quietly, and its return is not a second start.

Since #212 the push carries facts rather than states, and the same rule moved with it: `Dots::replace` keeps a tab or chat fact a push leaves out while the tab's PTY or the chat is alive, so a reload changes no dot and fires no second notification.

## Related

- [[concept_socket_event_vocabulary]] - the events this protects
- [[component_app_socket]] - `SessionStates` and the push
- [[component_tab_restore]] - why restore is per workspace
