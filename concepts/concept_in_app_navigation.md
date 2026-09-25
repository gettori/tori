---
summary: one NavTarget {folder?, session?} on one NAVIGATE event, answered by the sidebar; links, cockpit and notifications all use it
status: current
updated: 2026-09-25
source: gettori/tori#218 on branch orchestrator, plan "Ticket refs that say where they are, and one way to navigate there"; commit 380c7112; src/utils/events.ts:100; src/panels/LeftSidebar/LeftSidebar.tsx:1086; src/panels/Chat/links.ts:21; src-tauri/src/presence.rs:81
---

# In-app navigation

Anything that wants to take the user somewhere in Tori names a `NavTarget`, a folder, a session or both, and emits `NAVIGATE` with it. The sidebar answers, because selection is the sidebar's: it alone knows the spaces, the units and the checkout guard. Before this, every surface that pointed somewhere (a notification, a tray entry, a chat link) had its own partial route, and a notification click only brought the app forward.

## How it works

- **The target.** `NavTarget` in `src/utils/events.ts`, mirrored by `NavTarget` in `src-tauri/src/autopilot.rs`, which both the autopilot's references and the notification command use. Folders are absolute paths, never names, so a renamed space does not break a link already written in a transcript.
- **The answer.** `navigateTo` in `LeftSidebar.tsx:1086`. With a session it loads the folder's sessions if the store has not seen it, then selects the session, which opens its tab. With a folder alone it selects the unit at that folder, and for a worktree project's own container folder, the unit that is checked out (`locate`). It switches the sidebar to the target's space and expands the project, since selecting a unit never moved the space by itself.
- **Never a checkout.** A session whose recorded branch is not the one a plain repo has checked out gets a toast, not a switch: a link is "show me", and changing a shared working tree behind it would disturb every tab open there. A folder that no longer resolves also gets a toast.
- **Who sends it.**
  - The cockpit's ticket places, Watch and popup rows ([[component_autopilot_cockpit]]). The autopilot store also listens and closes the popup and leaves the cockpit view, since wherever it goes is in the workspace.
  - Chat links written `tori://open?folder=..&session=..`, which `linkTarget` in `links.ts` turns into a `navigate` target before its cwd guard. A folder that is not absolute is ignored.
  - A needs-you notification click, which Rust emits as `nav://open` and the sidebar forwards ([[component_presence]]).

## Why it is this way

- One event rather than a function call, because the senders live in places that must not import the sidebar, and the webview's bus already carries every other cross-panel action.
- The tray still sends a bare session id on `tray://focus-session`. It could move onto this, and so could PR tabs and the graph, but moving them was out of scope.
- `tori://` is not registered with the OS, so these links only work inside Tori.

## Related

- [[component_autopilot_store]]: builds each item's `reference`, whose `target` is a `NavTarget`
- [[component_autopilot_cockpit]]: the main sender
- [[component_presence]]: the notification click
- [[gotcha_the_notification_plugins_desktop_send_never_reports_a_click]]: why a notification needed its own route here
