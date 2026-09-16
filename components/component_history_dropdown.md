---
summary: every session for the branch on screen sits in one dropdown, replacing the sidebar tree, at the cost of showing less
status: current
updated: 2026-08-15
source: "Session navigation moves to a History dropdown; pi and opencode are removed (branch `navigation`, phases 5-6); commits a713a26, 61eb767, dfda207; Kobalte migration: plan \"Popover onto Kobalte Popover\" (branch `104-popover`, issue #104)"
---

# History dropdown

**Location:** `src/panels/Terminal/HistoryPanel.tsx`, `HistoryPanel.module.css`, `src/utils/sessionBuckets.ts`

Every session anchored on the workspace currently on screen, as a dropdown off the tab bar's History button. It replaced the sidebar's session rows: the tree made you navigate to find a session, this makes you navigate not at all, at the cost of showing nothing outside the branch you are working in. It owns almost nothing — it reads the two session stores and emits one event.

## Responsibilities

- **Owns** the list: search, the `OPEN NOW` section, `last_active` era buckets, and the collapsed `Historical (N)` disclosure with its Adopt action.
- **Owns** keyboard navigation (arrows + Enter) and its own `role="dialog"` / `role="listbox"` structure.
- **Does not** act on a session. Opening, renaming and deleting all belong to the sidebar and are reached through one event.
- **Does not** change which folder it lists. The breadcrumb is a label, not a control.

## Key files & entry points

- `HistoryPanel.tsx` — the panel; takes `folder`, `breadcrumb` (segments), `openSessionIds`, `anchorEl` (the `anchor` rect died with #104: Kobalte anchors to the element itself, so Terminal measures nothing)
- `src/utils/sessionBuckets.ts` — `bucketByLastActive`, pure, the era split
- `src/panels/Terminal/Terminal.tsx` — the History button, its badge, and `historyCrumb()`
- `src/utils/events.ts` — `SESSION_ACTION` (`{sessionId, action: "open" | "rename" | "delete"}`)

## Connections

- Reads [[component_session_stores]] — both of them; it holds no session state of its own
- Renders through [[component_popover]] — portalling, anchoring, dismissal, and since #104 focus too: the search field is the wrapper's `initialFocus`, restore is the wrapper's `onCleanup`, and the panel's own focus block is gone. One dismissal change rode along, adopted and pinned: focus leaving the panel closes it now.
- Hangs off [[component_overflow_tab_bar]] — the trailing reserve the button occupies
- Marks rows with the same rule as the tab strip — see [[concept_session_certainty_tiers]]
- Supersedes the session level of [[adr_sidebar_project_manager]]

## Design notes worth keeping

**`SESSION_ACTION` is the whole seam.** The three things a row does are exactly the three the terminal pane cannot reach: `ensureBranch`'s plain-repo checkout guard, the rename prompt, and the destructive delete confirm with its close-the-child-first ordering. Copying any of them into the panel would have been a second implementation of a thing that already has tests. That handler is registered in the sidebar's **component body**, not its async `onMount` — see the gotcha below.

**Two orderings, because they answer different questions.** `OPEN NOW` is what has a tab, whatever its age; everything else falls into `last_active` eras. The two sets are exact complements, which is the whole of "every session appears exactly once". Era boundaries are local midnights, not rolling 24-hour windows, so last night at 11pm reads as "Yesterday" at 1am.

**The button's badge is a count, not a rollup.** A session with no tab caps at "running" by construction, so a four-state bubble would only ever have shown one state.

**It borrows its look rather than inventing one.** Base font size sits on the panel and is inherited, the way the sidebar puts it on `.tree`; the search field is the sidebar's filter field to the pixel; the breadcrumb takes *segments* so its separator can be the menubar's `ChevronRight` rather than a slash baked into a string.

## Related

- [[gotcha_a_window_listener_registered_in_an_async_onmount_can_miss_a_startup_event]] — why the sidebar's handler moved to the component body
- [[gotcha_overflow_hidden_on_a_positioned_bar_clips_its_own_dropdown]] — why the panel is portalled
- [[gotcha_a_midnight_crossing_makes_an_offset_from_now_fixture_land_in_yesterday]] — the era test that bit
- [[gotcha_a_rounded_row_highlight_has_nowhere_to_put_a_left_rail]] — hover vs keyboard on these rows
