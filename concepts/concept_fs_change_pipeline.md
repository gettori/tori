---
summary: one debounced backend watcher feeds every consumer, with a set command muting an LRU so a Feature's members stay live
status: current
updated: 2026-08-26
source: "CM6 editor migration plan (personal/tori), Phases 1, 3 to 5, commits ccd7337, bef939a, 784724b, d642ab4, payload contract from \"Fix the stale `fs://changed` payload contract in ReviewPanel\" (branch `wave-1-3`, issue #12), watcher LRU and root-scoped payload from \"Worktree and tab switching at native speed\" (branch `unified-tab-bar`, phase 2, commit d8714d0), the watch *set* from Features phase 3: unified file explorer across member roots (branch `feature-workspace`, issue #155, phase 3, commit 7580a41)"
---

# Filesystem-change pipeline

**Location:** `src-tauri/src/fs.rs` (`fs_watch_start`, `fs_watch_set`), `src/utils/selfWrites.ts`, `src/utils/events.ts`

How Tori reacts to files changing on disk so the editor stays live without polling. One backend watcher feeds many same-origin consumers; Tori's own writes are filtered so a save never looks like an external edit. This is the glue that the agent-first workflow (the terminal edits files while you watch) depends on.

## The mechanism

- **Watcher LRU** (`fs_watch_start`): `FsWatch` holds up to **3** per-root watchers, mirroring `retainLspRoots`, rather than replacing the prior one on every switch. A recursive `notify` watcher pushes paths through an `mpsc` channel into a **trailing-edge debounce** thread (collects a burst into a `BTreeSet`, emits one `fs://changed` Tauri event after 250ms quiet). Re-selecting a warm root flips **mute flags only**: warm `fs_watch_start` bodies cost 0.01-0.07ms against 1-20ms for an install. Muted roots drop events **at the notify handler and again at emit**, so a churning background root neither emits nor piles up channel memory. A switch already refreshes tree and git state, so no catch-up event is owed.
- **The payload carries its root.** `fs://changed` includes `root`, and all nine listeners filter on it, which is belt-and-braces against switch races. The payload root stays optional so fixtures without it keep passing.
- **Churn filter:** before emit, drop any path under `.git`/`node_modules`/`dist`/`target`. Without this, follow-mode and the git gutter chase build output and git internals (see [[gotcha_the_project_watcher_must_filter_churn_dirs]]).
- **Consumers** subscribe to the `fs://changed` Tauri event directly (no second frontend bus): the [[component_cm6_editor]] git gutter refresh, clean-buffer auto-reload / dirty-buffer conflict banner, follow-mode (`EditorPane`), and the review-list refresh.
- **Payload contract.** `FsChanged` (`src/utils/events.ts`) is the one typed home for `{ paths: string[] }`, mirroring `struct FsChanged` in `fs.rs`. It is a type, not an event name: the event is emitted by Rust and listened to directly. Consumers split into two honest kinds, and which kind a consumer is should be visible at its `listen` call. Those that **read the paths** pass the type (`listen<FsChanged>`) and act per path: [[component_cm6_editor]]'s buffer reload (`CodeEditor.tsx`), follow-mode (`Editor.tsx`), and [[component_changes_panel]]'s expanded-diff refetch. Those that **deliberately ignore the payload** take no type argument and refresh wholesale, because their work is not per-file: `SessionPanel`, `CheckpointTimeline`, [[component_search_panel]]. Never bridge the two with an `as` cast, see [[gotcha_an_as_cast_on_an_event_payload_opts_out_of_the_contract]].
- **Echo suppression** (`selfWrites.ts`): on save, `markSelfWrite(path)` records a path with a short TTL; every consumer checks `isSelfWrite(path)` (a non-consuming peek, so multiple consumers can each skip the same echo) and ignores the watcher event the save itself triggers. The gutter still refreshes via an explicit on-save call so suppression doesn't starve it. See [[gotcha_save_triggers_its_own_fs_watcher_echo]].
- **Payload event bus** (`events.ts`): the payload-less `emit`/`on` plus generic `emitWith`/`onWith` (via `CustomEvent.detail`) carry `OPEN_IN_EDITOR { path, line?, col? }`. File-change fan-out deliberately rides the backend `fs://changed` Tauri event, not a frontend `FILE_CHANGED`.

## A set of foreground roots, beside the LRU

A Feature opens N member worktrees at once, and `fs_watch_start`'s contract is
"this root is the foreground one": every other entry gets muted, and three is
the working set of *recently visited* roots. That is the wrong shape for a
Feature, where every member is in front at the same time. `fs_watch_set(roots)`
(`fs.rs:694`) is a second command rather than a flag, so the unit path's LRU,
its mute semantics and its test are untouched.

- **`touch_roots` (`fs.rs:521`) is not an LRU.** It keeps the named roots in
  member order, unmutes all of them, and **evicts everything outside the set**,
  returning only the roots that still need a watcher installed.
- **The cap is its own constant**, `MAX_WATCH_SET_ROOTS = 8` (`fs.rs:511`).
  `MAX_WATCHED_ROOTS = 3` exists on purpose and nothing caps how many
  repositories a Feature may span, so `max(3, roots.len())` would have handed
  the bound to whoever adds a ninth repo. Members past the cap refresh when
  they become the active root.
- **Both commands share `install_watcher` (`fs.rs:626`)**, so the notify
  handler, the channel and the debounce thread are one code path and the two
  commands differ only in bookkeeping.
- **A member whose worktree is not on disk is filtered out** before
  `touch_roots`: its section already says so, and its siblings still want a
  watcher. A member whose install *fails* has its entry removed rather than
  kept, or it would read as warm to the next `touch_roots` and the install
  would never be retried. One member losing live refresh does not `?` out of
  the loop and cost the rest of the Feature theirs.
- **An empty set still goes out for a Feature.** Skipping the call would leave
  the previous Feature's members watched and unmuted, emitting bursts for a
  tree nobody is looking at.
- **The frontend issues it from an effect keyed on the joined root list**, not
  on the active member: moving between members re-issues nothing, and
  repairing a member grows the list rather than leaving the newcomer muted for
  the session. That list goes through a `createMemo`, see
  [[lesson_a_solid_effect_inherits_the_change_rate_of_what_it_reads]].
- **Every consumer inside a Feature is unmuted at once, so the payload's `root`
  tag is the only thing separating them.** Each tree section subscribes on its
  own and filters on its own root, behind the same 400ms debounce the Todos,
  Tasks and Search panes use. A branch unit gained the same per-directory tree
  refresh, which it never had.

## Why this shape

A single debounced+filtered backend event with same-origin consumers keeps the editor reactive to terminal/agent edits while avoiding event storms and self-induced reload loops. The augmented PATH (`env::augmented_path`, shared by [[component_pty_host]], [[component_lsp_host]], `launch.rs`) is the sibling "spawn things the way the user's shell would" rule.

## Related

- [[component_cm6_editor]] — the main consumer.
- [[component_changes_panel]] — the consumer whose refetch is scoped to one file, so it is the one that actually depends on the payload being read correctly.
- [[gotcha_save_triggers_its_own_fs_watcher_echo]] · [[gotcha_the_project_watcher_must_filter_churn_dirs]] · [[gotcha_an_as_cast_on_an_event_payload_opts_out_of_the_contract]]
- [[concept_filesystem_source_of_truth]] — Tori derives state from disk; this keeps that derivation live.
- [[adr_no_sync_ipc_commands]] - why the watcher rebuild had to stop being a per-switch cost.
- [[concept_feature_workspace]] - the workspace that needs N foreground roots at once.
- [[component_project_file_tree]] - the per-section subscription that reads the payload's `root`.
