---
summary: measures an inert ghost row to decide what fits, and a gesture flag cleared in a queueMicrotask made every tab dead
status: current
updated: 2026-08-20
source: "Overflow-tab-bar plan (personal/sway, branch code-mirror-6), `src/components/OverflowTabBar.tsx`, `tabOverflow.ts`, `+N` named and tooltipped, first mounted test: plan \"Tooltip primitive and the `title=` sweep\" (branch `102-tooltip-primitive`, issue #102), `src/components/OverflowTabBar.test.tsx`, commit dbfa12a, re-measure gating from \"Worktree and tab switching at native speed\" (branch `unified-tab-bar`, phase 4, commit f16b6ae)"
---

# Overflow tab bar

**Location:** `src/components/OverflowTabBar.tsx`, `src/components/tabOverflow.ts` (+ `tabOverflow.test.ts`, `OverflowTabBar.test.tsx`)

A generic, scrollbar-free tab bar shared by both `TerminalArea` (terminal tabs) and `EditorPane` (editor tabs). When the tabs do not all fit it renders only the ones that fully fit plus a `+N` count button whose dropdown lists the rest; selecting an overflow tab moves it into the last visible slot. It replaced the old `overflow-x:auto` scrollbars on `.term-tabs`/`.editor-tabs`.

## Responsibilities

- Render the bar from `items` (canonical order) with a consumer-supplied `renderTab` / `renderMenuItem`, plus a pinned `trailing` action (the `+ New` / `Follow` button).
- Decide how many tabs fit and collapse the rest into a `+N` dropdown, never a scrollbar (the bars are `overflow:hidden`).
- Keep the active tab visible and let the user pull an overflow tab into view; persist only explicit reorders.

## How it works (the three load-bearing mechanisms)

- **Inert ghost-row measurement.** A hidden clone of every tab (`.otab-ghost`: `position:absolute; visibility:hidden; pointer-events:none; padding:0`) carrying the same bar class reproduces the real gaps/padding/borders, so each tab stays measurable while out of flow. `measure()` reads each ghost child's `getBoundingClientRect().right` minus the ghost's left to get true cumulative **extents**, then `computeVisibleCount(extents, barWidth, reserves)` (pure) subtracts bar padding, the trailing action width, and the `+N` button width **including its horizontal margins** (a margin omission would over-count and clip a tab), plus a small safety margin. A `ResizeObserver` watches both the bar (available width) and the ghost (content width: a new tab or a dirty dot), and an effect re-measures on `items` change; a `requestAnimationFrame` first pass avoids a zero-width initial read.
- **Display-only active pull-in.** `displayOrder` is a `createMemo` that, when the active tab's index is beyond `visibleCount`, returns it moved into the last visible slot **for rendering only**, never calling `onReorder`. So narrowing the window (or selecting an overflowed session) shows the active tab without permanently scrambling the user's tab order; widening restores it. See [[gotcha_active_always_visible_must_not_mutate_the_canonical_tab_order]].
- **Identity-preserving reorder.** Clicking an overflow item calls `onReorder(moveIntoView(items, id, visibleCount-1, idOf))`; `moveIntoView` returns a new array of the **same element references** (shallow copy + splice), so the referentially-keyed `<For>` in `.term-stage` / the editor reorders DOM nodes instead of remounting them. See [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]].

The dropdown is rendered through a Solid `<Portal>` to `document.body` (fixed-positioned under the `+N` button), so the bar's `overflow:hidden` cannot clip it; see [[gotcha_overflow_hidden_on_a_positioned_bar_clips_its_own_dropdown]]. It closes on outside-click, Escape, or selecting an item, and auto-closes when its last entry is closed.

## Key files & entry points

- `src/components/OverflowTabBar.tsx` — the component (measurement, `displayOrder`, dropdown, portal).
- `src/components/tabOverflow.ts` — pure `computeVisibleCount(extents, barWidth, reserves)` and `moveIntoView(items, id, toIndex, idOf)`; DOM-free and unit-tested in `tabOverflow.test.ts` (vitest, node env via a standalone `vitest.config.ts`, see [[gotcha_vite_plugin_solid_forces_a_jsdom_test_environment]]).

## Consumers must be content-width, not `flex: 1`

A bar whose tabs stretch cannot be measured. Migrating the right panel's mode strip onto this component (2026-07-20) required dropping `.rightTab { flex: 1 }`: the ghost row measures each tab's **own** width, so a stretching tab measures as whatever the flex line handed it rather than as its label, and the fit calculation is meaningless. Visible consequence of adopting the primitive: tabs become content-width and left-aligned instead of equal-width, and collapse to `+N` on a narrow pane. Worth stating up front to anyone migrating the next bespoke tab strip onto this.

Consumers also need stable item identity — the `<For>` is referentially keyed, so item descriptors rebuilt on every read tear down and rebuild every tab's DOM. The mode strip keeps its descriptors as module-level singletons for exactly this reason.

## Connections

- Hosts the terminal tabs of [[component_pty_host]] (`TerminalArea`), the editor tabs of [[component_cm6_editor]] (`EditorPane`), and the right panel's mode strip; reorder preserves identity so neither a PTY nor an editor buffer is torn down.
- Governed by [[adr_stack_choice]] (Solid front end).

## Overflow rows spell the repo out

Inside a Feature the `+N` rows read `<repo> / <rel path>` rather than a basename plus a chip, because the overflow menu is precisely where two members' same-named files end up side by side, and a dropdown row has the width for it where a pill does not. Both strips do it: `Editor.tsx:2388` and `Terminal.tsx:2049`. See [[concept_repository_identity]].

## Related

- [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]]
- [[gotcha_overflow_hidden_on_a_positioned_bar_clips_its_own_dropdown]]
- [[gotcha_vite_plugin_solid_forces_a_jsdom_test_environment]]
- [[gotcha_active_always_visible_must_not_mutate_the_canonical_tab_order]]

## The trailing reserve carries a History button (2026-07-31)

The terminal pane's bar gained a History button in its trailing area, after the
new-terminal split button (branch `navigation`, phase 5). The reserve width the
collapse maths subtracts grew to match, and `tabOverflow.test.ts` asserts the bar
still collapses spillover into `+N` rather than scrolling at the new width - the
property that matters is unchanged, only the number moved.

Both dropdowns hanging off this bar now open 12px below their button and describe
their trigger's real span, and both render through [[component_popover]]. The bar
is `overflow: hidden` by necessity, which is exactly why they portal.

## The tab strip is not a tablist (2026-08-12)

The first run of [[concept_axe_accessibility_gate]] found that this bar wraps its
tabs in a plain `<div>` (`OverflowTabBar.tsx:114`) while `Tab`
(`src/components/Tab/Tab.tsx`) sets `role="tab"`. So the Editor strip (`Editor.tsx:1755`, `:2034`) and the
Terminal strip (`Terminal.tsx:1143`) both emit tabs with **no `role="tablist"`
ancestor**, which axe reports as `aria-required-parent`, impact critical. Only
`Settings.tsx:336` sets the role, so the pattern exists in the repo and the shared
bar simply does not follow it. Filed as **#114**; the fix most likely belongs here
rather than at each call site, together with the roving-tabindex and
`aria-selected` contract a real tablist owes.

A second finding is `Tab`'s own: its close affordance is a `<button>` nested
inside the `<button role="tab">`, which axe reports as `nested-interactive`
(**#115**). Both were invisible to every existing test, since none of them asked.

## Related

- [[component_history_dropdown]] — the panel the History button opens.
- [[component_popover]] — what both dropdowns position through.
- [[concept_axe_accessibility_gate]] — found #114 and #115 here on its first survey.
- [[gotcha_overflow_hidden_on_a_positioned_bar_clips_its_own_dropdown]]
- [[gotcha_jsdom_measures_everything_as_zero_wide_so_overflowtabbar_hides_every_tab_label]]

## The `+N` button, and what its test is actually for (#102)

It was a raw `<button>` carrying a native title, so its only content was a `+N` glyph and it had **no accessible name at all** - the title was hover text and nothing else. It is now `<Tooltip as="button">` with a matching `aria-label` ([[concept_tooltip_trigger_is_the_control]]).

That swap is why the file finally has a mounted test. The button holds a `ref` that `openMenu()` reads for its anchor and **returns early without**, so a ref swallowed by the polymorphic trigger would have left the overflow menu silently unopenable: a control that looks right and does nothing. Nothing in the suite opened that menu, so the test was written to open it and verified to fail with the `ref` removed. jsdom's zero widths are what make the setup trivial - every tab overflows, so the `+N` button is on screen without faking a layout ([[gotcha_jsdom_measures_everything_as_zero_wide_so_overflowtabbar_hides_every_tab_label]], whose second half is the ghost row this bar measures from).

## The `+N` menu, the ghost, and two older defects (#103, 2026-08-15)

**The menu is Kobalte's now.** `openMenu()`, `menuPos` and the `getBoundingClientRect` the section above describes are all gone: the menu hangs off a real trigger through [[component_menu]]. The `ref` that test was written to protect no longer exists, so the same test now guards one layer out, that the click still reaches the wrapper.

**The button is wrapped, and the wrapper had to be told it is one.** The `+N` control belongs to its `Tooltip`, so the menu goes around it rather than being it, and that wrapper needs a real box (`inline-flex`) because a dropdown anchors on its trigger's rect. It also arrived as a *second control*, `role="button"` with `tabindex="0"` around a button, until `wrapper` on the `Dropdown` took that back. See [[concept_menu_trigger_wrapping]] and [[lesson_a_wrapper_is_a_control_until_told_otherwise]].

**`renderTab` takes a `ghost` flag.** Consumers use it to render a menu on the real row only: the ghost is a copy, and a copy with a right-click menu on it is a second trigger for the same tab. That also means a test that right-clicks a tab has to reach the visible one, which needs the measurement frame flushed. The cause of the ghost-only strip was misrecorded for two tickets, see [[gotcha_jsdom_measures_everything_as_zero_wide_so_overflowtabbar_hides_every_tab_label]] and [[lesson_the_measuring_ghost_answered_the_test]].

**Two defects this bar has had all along**, found by the first axe scan run over it with a menu open, and left unfixed because neither is menu-shaped and #103 was a migration:

- Its tabs carry `role="tab"` with no `role="tablist"` above them (`aria-required-parent`). The section "The tab strip is not a tablist" above explains why the roles are what they are; the scan is what says axe disagrees.
- The measuring ghost is `aria-hidden` while holding focusable buttons (`aria-hidden-focus`), which is a real focus trap for a keyboard in a browser, not a jsdom artefact.

Both are named and disabled at that one scan in `OverflowTabBar.test.tsx` rather than swept into a green run. **They deserve their own issue.** (That issue was #114 and #132, and the section below closes both.)

## It is a real tablist now (#111, 2026-08-16)

`Tabs.Root` and `Tabs.List` from `src/lib/tabs.ts`, with `Tab` as the trigger
([[component_tab]]). `aria-required-parent` and `aria-hidden-focus` are fixed and
their disabled rules deleted, so that scan now passes with only
`aria-valid-attr-value` off.

**Root lives inside the bar, never hoisted into Editor/Terminal.** That is
deliberate and it is about the future merged editor+terminal strip: one bar over
a heterogeneous item array, and a split is two instances of it. Hoisting the Root
into the panels would have made the merge a rewrite.

**`Tabs.List` is `display: contents` (`.otab-list` in `App.css`).** A tablist may
own nothing but tabs, so the `+N` button and the trailing action have to be its
siblings rather than its children; `contents` is what lets the list wrap only the
tabs while the strip stays the single flex row it always was.

**The bar cannot pass props to its own tabs**, and that shaped everything. A
consumer hands it `renderTab`, and a Solid element is already-constructed DOM by
the time the bar sees it. So both facts the bar knows travel through the `TabRow`
context instead:

- **Positions from the canonical list.** `aria-posinset`/`aria-setsize` count the
  tabs that are *open*, not the ones that fit, so a strip drawing three of twelve
  announces "3 of 12". Announcing "3 of 3" is the harm #114 actually named, and
  Kobalte writes neither attribute. This matters more here than anywhere, because
  arrows reach only the drawn tabs: an overflowed tab is keyboard-reachable
  through the `+N` menu alone, and `aria-setsize` is what keeps the strip honest
  about that.
- **The ghost is inert.** It renders through the same `renderTab` with everything
  `disabled` and no `role`, so it still measures true while joining neither the
  accessibility tree nor Kobalte's collection - where it would have registered a
  second item under every key the real row already holds.

**Two Kobalte behaviours had to be worked around**, both written up in
gotchas.md:

- Its tab root force-selects the first key *and calls `onChange`* whenever the
  value it holds names no rendered tab. Closing the active tab is exactly that
  state for one render, so an unguarded bar would have opened the leftmost file
  behind the user. The guard keys off the **gesture** rather than the state (a
  capture-phase listener records whether the event landed on a `[role="tab"]`),
  which also keeps a strip with nothing selected clickable. Closing lands
  correctly because `Tab`'s close button is a *sibling* of the trigger, so a
  click on it has no tab above it. See
  [[gotcha_kobaltes_tab_root_force_selects_the_first_key_and_calls_onchange_doing_it]].
- Its trigger selects on mouse **press**, with no `shouldSelectOnPressUp` on
  `Tabs.Trigger` and a `composeEventHandlers` that ignores `defaultPrevented`, so
  nothing passed in beside Kobalte's handler can veto it. Editor tabs are
  `draggable` and a drag is a press that never becomes a click, so carrying a
  tab's path out to the terminal would have loaded that file first. The bar
  swallows the press in the capture phase, scoped to triggers;
  `stopPropagation` stops listeners and not default actions, so focus-on-press
  and the drag itself are untouched, and Kobalte falls back to its click branch.
  **This is the fragile part of the component**: it leans on a library internal,
  and the only thing standing behind it is a test that fires a real
  `pointerType: "mouse"`. See
  [[gotcha_jsdoms_pointerdown_carries_no_pointertype_so_a_press_vs_click_test_proves_nothing]].

**What the tests cannot see.** The active pill's fill now comes from Kobalte's
`data-selected` through `:has`, and vitest stubs CSS Modules to the empty string,
so nothing in the suite can tell whether the selected tab looks selected. That is
a manual check. Same for the collapse widths in a real browser, the drag, and the
keyboard walk across a strip. (The drag and the keyboard walk have a harness now,
see the section below and [[concept_trusted_input_verification]]; the pill's fill
is still eyes-only.)

## The gate had the wrong lifetime, and no test could say so (#116 branch, 2026-08-16)

The gesture guard the section above describes shipped with a lifetime bug that
made **every strip in the app unclickable** - editor, terminal and right pane -
for the whole of `74f3e3d`. The flag was set in the capture-phase listener and
cleared in a `queueMicrotask`, which reads as "covers the synchronous handler
chain"; a browser runs a microtask checkpoint after *every* listener callback of a
user-initiated dispatch, and Solid delegates Kobalte's handlers to `document`, so
the flag was several checkpoints gone before the gate read it. `onChange` returned
early every time. The full suite stayed green throughout, because a scripted
dispatch never lets the JS stack empty
([[gotcha_a_capture_phase_flag_cleared_in_a_queuemicrotask_is_gone_before_the_targets_listener_runs]]).

**The gesture now lives in `src/utils/tabGesture.ts` and is scoped to the event
rather than to a timer**: hold the `Event`, read `eventPhase !== Event.NONE`. There
is no window to size and nothing to clear, and the property is assertable in jsdom
because jsdom resets `eventPhase` the same way.

**That lifetime is wider than the broken one, and one gesture had to be excluded
because of it.** Delete and Backspace close the focused tab and therefore *do*
land on a `[role="tab"]`, unlike a click on the close button; the panel's close
writes the tab list before it moves the id, Solid batches nothing in a delegated
handler, and Kobalte's heal fires in between - while the keystroke is still
dispatching. Reproduced in the bar's own test: without the exclusion, Delete on
`tab 0` activates `t1`. So `tabGesture` refuses a close keystroke by name.

**Two tests, because neither alone is enough.** The bar-level one covers the close
keystroke. `src/test/tabBarGate.test.ts` is a source guard that bans a deferred
clear in this file, and it exists because *nothing functional would fail* if one
came back - the regression cannot be reproduced under jsdom at all. The fix itself
was verified by driving this component's Storybook story with trusted CDP input,
against both the fixed and the unfixed bar
([[concept_trusted_input_verification]]).

## Related

- [[component_tab]] - the trigger, the `TabRow` seam, and why the close button is hidden.
- [[concept_trusted_input_verification]] - how the click was proved dead, and then alive.
- [[lesson_a_tablist_may_own_nothing_but_tabs]]
- [[lesson_a_test_that_passes_against_the_broken_code]]
- [[gotcha_kobaltes_tab_root_force_selects_the_first_key_and_calls_onchange_doing_it]]
- [[gotcha_jsdoms_pointerdown_carries_no_pointertype_so_a_press_vs_click_test_proves_nothing]]
- [[gotcha_a_capture_phase_flag_cleared_in_a_queuemicrotask_is_gone_before_the_targets_listener_runs]]
- [[gotcha_solid_delegates_its_jsx_handlers_to_one_document_listener_and_batches_nothing]]

## Re-measure is gated on the id set, not the item count

The ghost re-measure runs through a `createMemo` over the **joined id list**
rather than `props.items.length`. The bug it fixes was a *click*: `setPaneActive`
rewrites the placement store, every pane's item list is rebuilt off it, and so
every strip in the window re-measured even though no strip's contents changed.

Two things worth keeping straight here:

- **A worktree switch re-measuring is correct**, because the strips genuinely
  show different tabs either side of one. Only the click was wrong.
- **A tab id is a file path**, so the join separator must be one no path can
  contain, written as an escape sequence rather than a literal byte. See
  [[gotcha_a_tab_id_is_a_file_path_so_any_join_separator_can_collide]].

The ghost keeps its own `ResizeObserver`, so a renamed tab still re-measures.

## Related

- [[concept_workspace_tab_grouping]] — the placement store whose rewrite caused the storm
