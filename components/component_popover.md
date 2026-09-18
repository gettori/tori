---
summary: Popover stays mounted while open under a Show, so Kobalte never sees open to closed and onCloseAutoFocus is dead code
status: current
updated: 2026-08-15
source: "plan \"Popover onto Kobalte Popover\" (personal/tori, branch `104-popover`, issue #104, part of #93); previous hand-rolled surface: branch `navigation`; commit 1235880"
---

# Popover

**Location:** `src/components/Popover/Popover.tsx` (key files: `Popover.module.css`, `Popover.test.tsx`, `Popover.stories.tsx`, `src/lib/popover.ts`)

The anchored panel surface, rebuilt on Kobalte's popover through `src/lib/popover.ts` (allow-list: `Root`, `Portal`, `Content`). One consumer, the History panel; the menus have their own pair of wrappers ([[component_menu]]). The 206-line hand-rolled surface this replaces - rect maths, RAF measure-and-clamp, document `mousedown` - is deleted with #104, and its pixel-pinning suite with it.

## Responsibilities

- **Owns** anchoring (`anchorRef` to the caller's element, `placement` defaulting `bottom-end`, gutter 12, restating the old `align="end"` and `r.bottom + 12`), portalling, dismissal (Escape, outside press, focus leaving), the anchor-press exclusion, and focus at both ends (`initialFocus` on open, restore on unmount).
- **Owns** the base surface chrome (`Popover.module.css`: `--canvas-card`, border, radius, shadow, z-index 900 below Menu's 1000 so a nested menu lands on top). The opposite of the old contract, which left all chrome to the caller.
- **Does not** own layout. Width, height ceiling and padding stay in the caller's `class`.
- **Does not** render a `Trigger`. Anchored controlled mode only: the opening button belongs to the caller, which mounts the surface while it is open.

## Key files & entry points

- `src/lib/popover.ts` - the Kobalte door, one namespace object per the [[component_lib_boundary]] convention; `Trigger` and `Anchor` deliberately absent
- `Popover.tsx` - props: `anchorEl`, `placement`, `initialFocus` (an accessor, because the caller's ref is unassigned until the children render), `onClose`, `class`, `aria-label`, `ref` (the content element; HistoryPanel scrolls its arrow-key highlight through it)
- `Popover.test.tsx` - the wrapper contract: dismissal, anchor exclusion, focus handoff, axe gate
- `Popover.stories.tsx` - `Components/Popover`, the anchored playground

## Connections

- Used by [[component_history_dropdown]] - its only consumer
- Composes [[component_lib_boundary]]'s `lib/popover.ts`; governed by [[adr_headless_primitives]]
- Nested-surface behavior is Kobalte's layer stack - see [[gotcha_an_outside_press_dismisses_only_the_topmost_kobalte_layer]]
- Followed [[component_menu]]'s `Dropdown` anchor mode as the precedent

## Design notes worth keeping

**Mounted is open.** The caller renders it inside a `<Show>` with `open` pinned true, so Kobalte never sees an open-to-closed transition: Escape and outside presses arrive as `onOpenChange(false)`, the caller flips its signal, and the tree unmounts still "open". Consequence: `onCloseAutoFocus` is dead code here, and focus restore lives in `onCleanup` ([[gotcha_kobaltes_close_pipeline_never_runs_for_a_surface_that_unmounts_while_open]]).

**The anchor's press is excluded from dismissal by the wrapper.** Kobalte excludes only its `Trigger`, and anchored mode has none, so `onInteractOutside` prevents dismissal when the target is inside `anchorEl` - without it the toggle would close and reopen the panel in one gesture. The exclusion covers focus too: shift-tab back onto the button is not leaving.

**Dismissal semantics were measured, not assumed.** The plan assumed an outside press with a nested menu open would close both layers (Radix does); a failing test showed Kobalte dismisses the topmost layer only, so the old menu-goes-panel-stays behavior survives with no `dismissable` prop at all. The one real change against the hand-rolled surface: focus leaving the panel closes it. Both are pinned in `HistoryPanel.test.tsx` with comments naming what they replaced.

**Placement is floating-ui's now.** The clamp, the flip, and the hide-until-placed dance the old component hand-rolled are the popper's job. jsdom cannot exercise any of that, which is why the durable open/dismiss invariants live at the HistoryPanel level and the wrapper suite pins behavior, not pixels.

## Related

- [[concept_axe_accessibility_gate]] - both suites scan `document.body`, since the surface portals out of its render container
- [[gotcha_kobalte_reports_no_close_for_a_trigger_that_unmounts]] - why HistoryPanel tracks the open row menu by id
- [[component_usage_strip]] - the quota card is a `Popover`, with the hover timing kept in the strip because only it knows where the pointer is.
