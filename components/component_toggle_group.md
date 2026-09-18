---
summary: SegmentedControl, LayoutToggles and IconGrid share one toggle group door; arrows move focus, Space or Enter commits
status: current
updated: 2026-08-16
source: "plan \"SegmentedControl onto Kobalte ToggleGroup, absorb LayoutToggles\" (personal/tori, branch `108-segmented-control`, issue #108, part of #93); `src/lib/toggle-group.ts`, `src/components/SegmentedControl/SegmentedControl.tsx`, `src/components/LayoutToggles/LayoutToggles.tsx`, `src/test/interactiveTitle.test.ts`; extended by plan \"Dedupe icon and swatch grids into one IconGrid\" (branch `109-dedupe-icon-and-swatch-grids`, issue #109); commit cd09a5e; PR #138"
---

# Toggle group: `SegmentedControl`, `LayoutToggles` and `IconGrid`

**Location:** `src/lib/toggle-group.ts`, `src/components/SegmentedControl/`, `src/components/LayoutToggles/`, `src/components/IconGrid/`

The multi-button controls that share one primitive. `SegmentedControl` is the bordered single-select strip (New project mode, debug target, the styleguide); `LayoutToggles` is the topbar cluster that shows and hides the sidebar, terminal and editor; [[component_icon_grid]] is the icon and swatch picker both icon dialogs use. They look nothing alike and none wraps another: what they share is `@kobalte/core/toggle-group`, entering through one `lib/` module per [[component_lib_boundary]]. `SegmentedControl` keeps its external API exactly (`options` / `value` / `onChange` / `size` / `aria-label` / `class`), so all four consumers compile untouched.

## The keyboard model changed, deliberately

The old `SegmentedControl` was a `role="radiogroup"` where an arrow key moved the **selection** (selection-follows-focus, via the shared `nextSegmentIndex`). Kobalte's toggle group is the APG toggle-button pattern instead: arrows and Home/End move **focus only**, and Space or Enter commits. Segments are now toggle buttons carrying `aria-pressed`, not radios.

That is a real behaviour change for the two dialogs, and it is the reason their tests moved off `getByRole("radio")`. It also leaves the Settings tab strip, still on `nextSegmentIndex` with automatic activation, deliberately unlike the segmented control until the `Tab` ticket reunites them. `controls.ts` keeps the helper for exactly that one consumer.

Kobalte parks the tab stop on the **group** until focus arrives, then hands it to the pressed item and takes its own away. Either way the strip is one tab stop, and Tab enters on the selected segment.

## Two things Kobalte does not give for free

**Always exactly one selected.** Kobalte's single mode lets a press on the already-pressed item clear the selection, calling `onChange(null)`. `SegmentedControlProps` has no empty state, so the wrapper drops that change and the controlled `value` holds.

**Activation keys stay inside.** Kobalte selects on Enter/Space **keydown** and lets the event bubble. Both dialog consumers wrap the strip in a form-level Enter handler that confirms, so one Enter would select a segment *and* submit the dialog. The wrapper stops propagation of those two keys at its root, which makes the rule predictable: Enter inside the strip selects, confirming needs focus outside it. `stopPropagation` and not `stopImmediatePropagation`, so Kobalte's own root handler (composed after the wrapper's) still runs.

## A segment's name is a type now, not a docstring (#116, 2026-08-16)

`SegmentedOption` documented `aria-label` as "required when there is no text `label`" and typed both as optional, so an icon-only segment with no name at all compiled and reached axe as `button-name`, impact **critical**. It is a discriminated union now: a segment carries a `label`, or it carries an `aria-label`. All three call sites already pass text, so none of them moved.

Two things worth carrying forward from it:

- `NonNullable<JSX.Element>` on the label branch, because Solid types `JSX.Element` as including `undefined`, so a bare `label: JSX.Element` is satisfied by `label={undefined}` and the union would promise more than it checks ([[gotcha_solid_types_jsx_element_as_including_undefined]]).
- The axe fixture that builds the defect on purpose now carries `@ts-expect-error`, which *is* the assertion: drop the union and it becomes an unused directive, so the test fails without a line changing.

`Button` keeps a DEV `console.warn` rather than a type for a reason that does not apply here: its accessible name depends on what it renders and can be backfilled from a tooltip, neither of which a prop type can see. Where the rule is expressible, express it - a warning is ignorable and a type is not.

## `LayoutToggles`: the item *is* the icon button

`multiple` mode, one item per pane, each rendering `as={IconButton}`. Kobalte's polymorphism passes the item's props (pressed state, roving tabindex, the click that toggles, `disabled`) straight through `IconButton` onto the same `<button>` the tooltip triggers from. Wrapping instead would break both halves: tooltip behaviour lives on the trigger element ([[concept_tooltip_trigger_is_the_control]]), and the group's collection needs the focusable control, not a container around it. `IconButton` splits `aria-pressed` off its props and re-emits it, so Kobalte's value survives the trip.

The group reports the whole new set rather than what was pressed, so `onChange` finds the pane whose membership flipped and emits that pane's `TOGGLE_*` event. State still arrives back through props; the component holds none.

The ">=1 visible" invariant is unchanged: the last of the terminal/editor pair is `disabled`, and its tooltip says why. That tooltip only works because `Tooltip`'s `whenDisabled` hover surface survives being rendered through the toggle item, which is the composition's sharpest test and is pinned in `LayoutToggles.test.tsx`.

**The three items are written out, not mapped.** A `<For>` over an array rebuilt from props hands Solid new identities on every toggle, tearing down all three buttons and dropping keyboard focus, see [[gotcha_a_for_over_an_array_rebuilt_from_props_recreates_every_row]].

## What this closed

Selected state now rides Kobalte's `data-pressed` attribute in CSS (`.segment[data-pressed]`, `.item:not([data-pressed])`) rather than a class passed down from the caller. That is the direct resolution of [[gotcha_a_component_that_sets_its_own_classlist_clobbers_a_callers_classlist]] for these two: an attribute the primitive owns cannot be clobbered by `IconButton`'s own `classList`, where a caller's `classList` entry always was. It also raises specificity above `.iconBtn` rather than tying the result to stylesheet order.

## The guard it moved

`src/test/interactiveTitle.test.ts` asserts `tooltip=` is only written on a component that implements it, and it reads the **tag name**, so `<ToggleGroup.Item as={IconButton} tooltip=…>` read as orphaned. It resolves through `as={X}` now: a polymorphic host hands every unclaimed prop to its `as` target, so the target is what must implement the prop. Still strict, an `as` naming something that does not implement it fails, and a `tooltip` on a raw element fails.

## Two doors to the same item

`lib/toggle-group.ts` exports `Item` and `ButtonItem`, which are the same component twice. `Item` is Kobalte's own declaration, generic over what it renders as, which is what lets `LayoutToggles` write `as={IconButton}` and pass that button's props through. `ButtonItem` is it pinned to its own `as="button"` default.

The second door exists because a generic signature cannot be inferred *from*: hand `Item` to anything typed `Component<P>` and `P` resolves to `{}`, taking the required `value` with it, and the failure surfaces at runtime as a grid where clicking selects nothing. [[component_icon_grid]] needs exactly that inference, since its tiles are `<Tooltip as={ToggleGroup.ButtonItem} value=…>`. See [[gotcha_a_generic_polymorphic_component_cannot_be_inferred_from]].

Nothing else is withheld: the primitive has only these two parts.

## What the vertical keys do

Nothing, and that is not obvious. The root builds a horizontal keyboard delegate but hands `createSelectableCollection` no orientation, so ArrowUp/ArrowDown route into `getKeyAbove`/`getKeyBelow` and come back `undefined`. Invisible in a strip, a defect in a grid, see [[gotcha_a_kobalte_toggle_groups_arrowup_and_arrowdown_do_nothing]] and how `IconGrid` answers it.

## Connections

- [[component_lib_boundary]] — the `lib/toggle-group.ts` door, `Root`, `Item` and `ButtonItem`
- [[component_icon_grid]] — the third consumer, and the one that needed the concrete item type
- [[component_button]] — the control family these two leave for the primitives layer
- [[concept_tooltip_trigger_is_the_control]] — why the item renders *as* the icon button
- [[concept_axe_accessibility_gate]] — where both wrappers are judged
- [[component_storybook_workshop]] — the stories that carry both through light and dark
- [[adr_headless_primitives]] — the decision this implements

## Related

- [[gotcha_a_for_over_an_array_rebuilt_from_props_recreates_every_row]]
- [[gotcha_a_component_that_sets_its_own_classlist_clobbers_a_callers_classlist]]
- [[gotcha_a_disabled_control_cannot_show_a_tooltip_without_an_enabled_wrapper]]
