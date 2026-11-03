---
summary: every sidebar group shows six via capList, keeps open, selected and busy items in place, and its fold row carries their rollup
status: current
updated: 2026-11-03
source: Calm sidebar sections plan (branch global-space); src/panels/LeftSidebar/capList.ts:7; src/panels/LeftSidebar/LeftSidebar.tsx:3435; src/panels/LeftSidebar/ChatList.tsx; src/panels/LeftSidebar/TopicRows.tsx; src/panels/LeftSidebar/SidebarRows.tsx:233
---

# Sidebar group folds

Chats, Topics and projects in a space's tree each show at most `GROUP_CAP` (6) items. The rest sit behind a fold row ("3 more chats", "2 more Topics", "4 more projects", then "Show less"). Chats untouched for a week fold under one Older row. The point is a calm tree: three sections that read as sections, not one long list.

## How it works

- **One cut.** `capList(items, cap, keep)` (`src/panels/LeftSidebar/capList.ts:7`) returns `shown` and `hidden` in the list's own order, with every `keep` item past the cap left in its own place. Branch lists use it too (`BRANCH_CAP = GROUP_CAP`).
- **What is kept.** The selected item, an open one (an expanded Topic or project), and a busy one: `needsYouOrWorking` (`src/utils/sessionStatus.ts:158`) means executing, waiting for approval or an answer, or a pull request needing you. Opening is free, so a cap never closes anything.
- **The fold row reports what it hides.** While shut it carries the `StatusBubble` rollup of the hidden items, so tile rollups did not change: a hidden item is still on screen through its fold row.
- **Older.** In `ChatList`, a chat whose `updated` is older than `OLDER_AFTER` (7 days, `src/utils/chats.ts:136`) goes under Older at the bottom, closed by default. The selected chat and a busy chat never go there.
- **Filtering turns it off.** With filter text, every match lists, with no cap and no Older.
- **A space without Topics stays uncapped.** It has no Projects heading, so there is no section to fold under. The space tree renders the plain `activeProjects()` list then, and `projectFold` only when `topicsGroupSpace()` is set.
- **Remembered state** lives in the sidebar's `expanded()` set: `gcm:` (more chats), `gco:` (Older), `tm:<space>` (Topics), `pm:<space>` (projects), with `/global` for Home.
- **Two rows, one look.** Chat rows are rail rows (`BranchRow` inside `.projectCard`), so chats fold with `MoreRow`, on the rail like "N more branches". Topics and projects are card rows with no rail, so they fold with `FoldRow`: the same glyph and tone at card depth. Both are real `button`s with `aria-expanded`.
- **Headings.** `GroupHead` has 16px above it when not first and a `--fg-subtle` label. A collapsible heading shows its count only while collapsed or filtered (`filtered` prop); a space's Projects heading cannot collapse and keeps its count.
- **Quiet chips.** A collapsed Topic row keeps its member chips in the DOM with `data-quiet` at rest (`visibility: hidden`, so their room is kept and nothing moves). CSS brings them back on `.item:hover`, `:focus-within` and `[data-expanded]` (context menu open). The selected Topic and one with a member needing repair (`state.action != null`) never get `data-quiet`. jsdom cannot apply the hover and focus rules, so only the attribute is tested.

## Why it is this way

- Topics and projects are capped by name order, not recency, so nothing reorders under the user.
- Members of an open Topic stay uncapped.
- Rejected: accordion opening, auto-collapse of idle items, date headings in Chats, and tabs between sections. Each one hides or moves things the user did not touch.

## Related

- [[concept_chats]] - the chats this folds
- [[gotcha_the_sidebar_rail_is_a_variable_not_a_copy]] - why card lists do not reuse the rail row
- [[gotcha_a_non_keyed_show_child_reading_its_accessor_throws_when_cleared]] - hit by the first cut of the Topics fold row
