---
summary: context menu wrappers use display contents, dropdown wrappers need a real box since floating-ui measures its rect
status: current
updated: 2026-08-15
source: Menu onto Kobalte DropdownMenu and ContextMenu, phases 3 to 6 (personal/tori, branch `103-menu`, gettori/tori#103); `src/components/Menu/Dropdown.tsx`, `src/panels/Chat/Picker.tsx`, `src/panels/Terminal/Terminal.tsx`, `src/components/OverflowTabBar.tsx`, `src/panels/LeftSidebar/LeftSidebar.tsx`, `src/panels/Editor/Editor.tsx`; commits `7c610cb`, `a0913d9`, `3e0ddc4`
---

# Wrapping a control that already belongs to something else

A Tori control can belong to exactly one primitive. `Tooltip`, `ContextMenu` and `Dropdown` all render *as* their control (that is [[concept_tooltip_trigger_is_the_control]]: a Solid JSX element is already-constructed DOM, and nothing can inject a trigger's handlers into it afterwards), so a button that is already a tooltip's cannot also be a menu's. The second primitive has to go *around* it.

Five of Tori's nine menu sites needed that. This page is what the ticket learned about doing it, because a wrapper is never free and the price is different depending on which menu is wrapping.

## Which wrapper, and why the answer is not one wrapper

**A context menu anchors on the cursor**, through its own trigger, so its wrapper needs no box at all. `display: contents` is layout-neutral and still receives the right-click on its way up. The sidebar's space tile and the editor's tabs are this kind.

**A dropdown anchors on its trigger's rect**, and a `display: contents` element has no rect. Give one to a dropdown and floating-ui measures nothing and the menu opens in the top-left corner of the window. Those wrappers need a real box: `inline-flex` with `flex: none` reproduces the control's own width, margins included, so the surrounding strip lays out unchanged. The `+N` button, the terminal's split-button caret and the composer's pills are this kind.

Getting this backwards fails silently in one direction (a menu in the corner) and invisibly in the other (a wrapper with a box where none was wanted, changing layout by a hair).

## The three costs

**1. Specificity.** The wrapper's selector outranks the control's own state classes. `.spaceMenu[data-expanded] > .space` is (0,2,1) against `.space.active`'s (0,2,0), so the wrapper's open state quietly beat the tile's active state, in a stylesheet that deliberately orders `.active` after `:hover` at equal specificity ([[gotcha_same_specificity_hover_and_active_declare_active_last]]). Split the rule with `:not(.active)` and give the active case its own narrower rule. Check specificity against what the element already had, not against what the wrapper needs.

**2. The popup semantics land on the wrapper.** Kobalte writes `aria-haspopup`, `aria-expanded` and `aria-controls` on its trigger, which is now the wrapper. They cannot be taken off it, because [[gotcha_a_solid_spread_cannot_un_set_a_prop_the_jsx_already_named]]. So the control inside writes them itself, from the same signal that drives the menu, and both elements carry them. The one a keyboard actually reaches is the one that matters.

**3. The wrapper becomes a second control.** Kobalte makes any non-`button` trigger a `role="button"` with `tabindex="0"`. Around a control that is already both, that is two tab stops and a button inside a button, which axe reports as `nested-interactive`. `Dropdown` takes a `wrapper` prop for it, which overrides the role to `group` and the tab index to `-1`. Nothing is lost: everything the trigger listens for (pointerdown, and Enter/Space/ArrowDown as keydown) reaches it by bubbling up from the control inside.

`group` and not `presentation`, which reads like the obvious choice: `presentation` is the one role that forbids the global ARIA attributes, so it would trade `nested-interactive` for `aria-allowed-attr` while the attributes from cost 2 are still there. `group` is non-interactive and allows them.

A **context** wrapper pays only cost 1. `ContextMenuTriggerRenderProps` adds nothing but Kobalte's own dataset, no role and no tab index, which is why `wrapper` is a `Dropdown` prop and not a shared one.

## The site that needed none of it

Breadcrumbs. A crumb is a plain `<button>` with no tooltip, so `Dropdown as="button"` *is* the crumb, and the popup semantics land on the element the keyboard reaches for free. Worth naming because it is the exception that shows the rule is about ownership and not about menus: nothing else in the app had a control still free to be claimed.

## Connections

- [[concept_tooltip_trigger_is_the_control]] is why a control can only belong to one primitive at all.
- [[component_menu]] is where `wrapper` lives, and holds the recipe for both wrappers.
- [[component_overflow_tab_bar]], [[component_chat_panel]] and the terminal's launcher are the three dropdown wrappers; the sidebar and the editor tab strip are the two context ones.
- [[lesson_a_wrapper_is_a_control_until_told_otherwise]] is how cost 3 was found, two phases after it shipped.
- [[concept_axe_accessibility_gate]] is the scan that found it.
