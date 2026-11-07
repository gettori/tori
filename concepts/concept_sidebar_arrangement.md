---
summary: branches rank by unit key in sidebar-order.json; arrange() gives main (base, unlaned, then groups) plus one uncapped section per lane
status: current
updated: 2026-11-07
source: plan "Sidebar lanes, custom groups and branch line controls" (branch left-sidebar-customization); commits e55d6149, 7f6e2f5d, fbfd6656, b82fd20a; src/panels/LeftSidebar/arrange.ts:25; src/panels/LeftSidebar/LeftSidebar.tsx:4222
---

# Sidebar arrangement: order, groups and PR lanes

A project's branch list is in the user's own order. Groups are named cards held in `tori.toml`, and PR lanes optionally sort the loose branches into cards by pull request state, per Space. One pure function decides the layout and the sidebar only renders it.

## How it works

- **Ranks are per unit key** (`unitKey` = branch, else folder path, `arrange.ts`), never per stack, attempt group or group: those form and dissolve with forge and session state, and a rank on them would be lost each time. An entry ranks at the best of its keys. Unranked entries go on top (new branches land first); the base branch ranks above everything.
- **`arrange(entries, opts)`** (`src/panels/LeftSidebar/arrange.ts:25`) returns sections. Without lanes: one `main`, capped by `capList`. With lanes: `main` holds the base and unlaned entries, then the groups, capped; then one `lane:<id>` section per non-empty lane in `laneOrder(cfg)`, never capped.
- **Lanes** (`src/utils/prLanes.ts`): four parents (Working, In review, Reviewing, Done) over the 11 `prChildState` children. A lit child gets its own lane directly above its parent; `foldReviewing` moves Reviewing into In review. `laneOf` answers `null` for the base and for someone else's PR that never asked you. A stack or attempt group takes its first member's lane.
- **Arrival at top**: `ProjectOrder.lanes` in `sidebar-order.json` records where each unit was last seen (`main`, `group` or `lane:<id>`). `arrive()` (`arrange.ts:51`) moves a key whose record changed to the top of its new lane, ahead of the first key already there. Ungrouping is an arrival from `group`. The record survives a restart, so a change that landed while Tori was closed still arrives.
- **Pending**: a branch the forge has not answered for (chip `hidden` or `unknown`) is `pending`. It is drawn in its last recorded lane and its record is kept, see [[lesson_a_lane_recorded_before_the_poll_answers_reshuffles_every_launch]].
- **The hold**: `heldValue` (`LeftSidebar.tsx:618`) freezes poll-derived input (stack map, lane map) while the pointer is over the tree or a drag is in flight. Membership and the user's own drops stay live, so an edit lands at once.
- **Drag** is `createSidebarDrag` (`sidebarDrag.ts:50`), not `dragReorder.ts`: it crosses sections and still carries the path payload for terminal drops. Groupable rows give their middle half to "group with". `refuse` turns a drop into another lane into `dropEffect = none` plus a note that follows the pointer, since the platform draws the ghost.
- **Groups** are written through `set_project_groups` (`src-tauri/src/config/groups.rs:140`); `forget_branch` drops a removed branch, and a group goes with its last member. An optimistic `groupEdits` overlay shows an edit before the reload reads it back.
- **Parking** reuses the `expanded()` set: `lane:<path>#<lane>` flips `startsParked` (parents but Working start parked).

## Why it is this way

- Groups sit above lanes and keep their order whatever their PR state: placing a group in its most urgent member's lane was rejected, since it would jump lanes every poll.
- Lanes and arrival at top break the old "nothing reorders under the user" rule ([[concept_sidebar_group_folds]]) on purpose. They are opt-in, and the hold keeps the row under the pointer still.
- Lane order is fixed; dragging lanes was rejected as a third thing to arrange.

## Related

- [[adr_sidebar_arrangement_storage]] where each piece is stored, and why
- [[concept_sidebar_group_folds]] the cap that `main` still follows
- [[gotcha_jsdom_dragevent_drops_clienty_from_its_init]] how the drop zones are tested
- [[gotcha_check_tokens_reads_a_quoted_hue_name_as_a_colour_literal]] how card colours stay out of stylesheets
- [[gotcha_the_sidebar_rail_is_a_variable_not_a_copy]] why cards re-anchor the rail variables
