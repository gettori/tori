---
summary: the webview reports raw facts and Rust composes the agent state, the display dot, the unit and presence, so every client agrees
status: current
updated: 2026-09-26
source: gettori/tori#212 on branch orchestrator; commits 43723d9a, a6de3348, f08f46c9, 21533ec4; src-tauri/src/rpc/dots.rs, src-tauri/src/presence.rs, src-tauri/src/unit_home.rs, src/utils/sessionActivity.ts
---

# Rust composes the dot from facts the webview reports

## Context

The sidebar's dot was composed in the webview from PTY activity, the transcript tail, the liveness probe, chat status and forge attention, then pushed into Rust with the forge left out ([[adr_socket_asks_the_webview_until_rust_owns_state]]). So `tori sessions` and the sidebar could disagree on a red branch, a phone would only ever see what the desktop last pushed, and presence (rising edge, attended, notification, tray, badge) lived in a window that can reload. Some inputs only the webview has: which tab hosts a fresh session, a chat's status, the selection and focus, and the forge poll's answer.

## Decision

- **The webview reports facts, Rust composes.** `rpc_session_facts` sends tab bindings, each chat's status, name, visibility and spawner, and forge attention per branch unit. `rpc_attention` sends the selection and focus. Rust adds what it measures (PTY activity, the tail, its own pgrep probe) and composes in `rpc/dots.rs`, pinned by the two golden fixtures in `src-tauri/src/rpc/fixtures/`.
- **Two outputs per session.** The agent `state` never includes the forge raise and drives `session.state`, `session.needs_you`, `session.wait` and steer. The display `dot` does include it and drives the sidebar, `sessions.list` and presence. A red check therefore raises the dot but fires no `session.needs_you`, since the autopilot already hears it as `session.pr`.
- **Chat status is a reported raw fact.** The chat store's reducer stays in the webview.
- **Same-tick guards read the webview's own status.** The revert guard and stop read the chat's raw status, so a revert cannot land under a turn that just started while Rust catches up.
- **One edge detector.** Rust's `Presence` owns the rising edge and attended, and fires the notification, tray and badge itself ([[component_presence]]).
- **Rust probes on its own triggers** (a subscriber arriving, a stale `sessions.list`, a transcript moving), so a detached session that exits turns `none` without a desktop click.

## Alternatives rejected

- **Rust resolving a fresh tab's session itself:** drags session discovery into `pty.rs`.
- **Keeping the composed-dot push:** the CLI and a phone stay only as fresh as the desktop's last push.
- **One dot for both uses:** sends a red check to the autopilot twice, as `session.pr` and as needs-you.
- **Leaving forge out of Rust:** the CLI and the sidebar disagree on every red branch.
- **Porting the chat status reducer into `ChatHost`:** background tasks, budget stops and answerable prompts make it a ticket of its own.
- **Routing the revert guard through Rust:** opens an async gap where a revert lands under a running turn.
- **Rust computing attended while the webview fires the side effects:** two detectors that can disagree.

## Consequences

- A fact missing from a push (a reload, a workspace not revisited) is held while its tab or chat is alive, so a reload changes no dot and fires no second notification.
- The forge poll stays in the webview, the one input a socket client still needs the desktop for.
- More pgrep calls than before, since Rust probes without waiting for a click.
- Unit attribution is Rust's too (`unit_home::belongs_to_unit`), and every `sessions.list` row and dot change names its `home`, so no client joins for itself.

## Related

- [[adr_socket_asks_the_webview_until_rust_owns_state]]: the push this replaced
- [[component_app_socket]]: where the facts land and the dots go out
- [[component_presence]]: the edge detector and the OS surfaces
- [[concept_needs_you_floor]]: the PTY join the composition runs
- [[concept_session_certainty_tiers]]: why a chat is exact and a PTY tab inferred
