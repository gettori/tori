---
summary: tabs restore inert with no process until reached for, but a reload reattaches every tab, beating a restore banner
status: needs-verification
updated: 2026-08-21
source: not recorded; imported from grimoire docs/personal/tori; `src-tauri/src/pty.rs`
---

# Tabs restore inert: lazy when attaching would spawn, eager when it only rewires

A restored tab is a strip entry with no process, no ownership claim and no
surface, and it attaches only when the user reaches for it; but a **reload**
reattaches every tab the backend still holds, because there the attach is a
rewire of a running child rather than a spawn. One rule covers both halves: the
cost of attaching decides whether it happens now or on demand. This replaces the
per-workspace restore offer, whose whole justification was that restore meant
spawning, and extends [[adr_draft_first_chat]]'s no-process-until-first-send from
new chats to resumed ones, so a restored chat renders its transcript from disk
and spawns on the first send.

## Considered Options

- **The restore offer (status quo)**: a banner per workspace, accept-all or
  nothing. Correct about the cost and wrong about the remedy: it asks a question
  instead of removing the reason for it, and on a reload it asks about sessions
  that are already running.
- **Uniformly lazy, reload included**: simpler to state, but a PTY's output is
  dropped when no sink is listening (`pty.rs`, `Sink = Option<Channel>`), so a
  live shell left inert loses everything it prints until clicked, and a live chat
  child with no tab is unaddressable and unkillable.
- **Uniformly eager, relaunch included**: the behaviour being replaced. Ten tabs
  across four workspaces means ten agents starting because the app opened.

## Consequences

- Tab ids are now persisted, reversing [[component_tab_restore]]'s "not stored:
  tab ids". That is what lets a reload reattach by id, and it restores per-tab
  pane placement for free, since [[concept_workspace_tab_grouping]]'s placement
  store is keyed by tab id.
- An inert tab holds no claim, so a session can be taken by another driver
  between restore and click. The refusal path already exists and renders in
  place; the same trade [[adr_draft_first_chat]] already accepted for drafts.
- An unattached chat reports on the detached tier of
  [[concept_session_certainty_tiers]] rather than the exact one. Honest, since it
  is not running: after a reload it is reattached and exact again.
- A tab has **three** states, not two: `inert` (a strip entry, no surface),
  `open` (a surface with no child: a chat's transcript, a draft's composer) and
  `live` (a child running). A terminal has no `open` state, because a PTY with
  no process has nothing to render, so it goes straight from `inert` to `live`.
  Two states would force a draft to spawn on click, which is the rule
  [[adr_draft_first_chat]] exists to prevent.
- The progression is **monotonic** for a tab's life. Moving back down it on a
  visibility change would be a destroy control wearing a visibility control's
  clothes, which is [[lesson_a_mount_gate_is_a_destroy_gate]] exactly.
- **"Has a tab" stops meaning "is running", and every consumer of the live-tab
  surface has to be told.** `LiveTab` carries the state for exactly this reason.
  The dangerous direction is not the overcount: `countRunningAgents` dedups the
  folder's sessions against the ids its tabs carry and probes only the
  remainder, so an inert tab holding a session id **suppresses the probe** for a
  session that really is running, and a destructive worktree confirm undercounts
  what it is about to disturb.

## Related

- [[adr_generic_panes_unified_tabs]] - narrows its "everything stays mounted" to
  everything attached
- [[adr_draft_first_chat]] - the no-process-until-send rule this generalises
- [[component_tab_restore]] - the offer this deletes
- [[concept_workspace_tab_grouping]] - the always-mounted stage it amends
- [[concept_session_certainty_tiers]] - the tier an inert tab reports on
- [[lesson_a_mount_gate_is_a_destroy_gate]] - why the latch is one-way
- [[adr_chat_opens_on_a_bounded_tail]]: a reload reattaching every tab is half of why history is bounded
