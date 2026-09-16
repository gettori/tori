---
summary: member chip row picks which Feature member Pull requests, Tasks, Shared and Docs point at, active one stays visible
status: current
updated: 2026-08-28
source: "Features phase 8: the right panel modes inside a Feature (#160), branch `feature-workspace`, phase 3"
---

# Member chip row

**Location:** `src/components/MemberChipRow/MemberChipRow.tsx`, `.module.css`, `src/panels/Editor/Editor.tsx` (`ACTIVE_ROOT_MODES`)

Which member Pull requests, Tasks, Shared and Docs are about, and the control that moves it. Those four answer for one repo ([[concept_right_panel_member_scope]]), and a Feature has several, so without this row the pane silently reported whichever member was last clicked in the tree.

## Responsibilities

- **Under the tab strip, not inside a pane.** One row above all four modes is one control to learn instead of four, and it disappears with them: `ACTIVE_ROOT_MODES` gates it, and it needs a Feature with more than one member. One member is not a choice.
- **The same pointer the Toolbar moves.** `onActiveRoot` is threaded App -> Editor and is the handler the crumb chips and the sidebar already call, so the three cannot disagree about which member is in front.
- **Capped at `CHIP_CAP`** (6, shared with the sidebar's collapsed Feature row) with the rest behind a `+N` dropdown that can switch to them.
- **The active member is never hidden.** Past the cap it takes the **last visible slot** rather than growing the row. A row whose job is to say which member the pane is about, and which cannot show that member, has no reason to exist.
- **A broken member keeps its place, wears its state and does not switch.** `disabled`, with an accessible name of `<label>: <state>`. There is no folder to point the panes at.

## Key files & entry points

- `src/components/MemberChipRow/MemberChipRow.tsx` - the row, the cap split, the overflow menu.
- `src/utils/featureMembers.ts` - `CHIP_CAP` lives here rather than in `FeatureItem`, so a component no longer imports from a panel; `FeatureItem` re-exports it for its own test.
- `src/panels/Editor/Editor.tsx` - `ACTIVE_ROOT_MODES` and the `<Show>` that gates the row.

## Related

- [[component_member_chip]] - the tinted initials this row's chips are built from.
- [[component_member_section]] - the other member surface #160 added, for the modes that group instead of switching.
- [[concept_right_panel_member_scope]] - why exactly these four modes get a switch.
- [[component_feature_list]] - the sidebar row that caps to the same number.
