---
summary: ContextMenu and Dropdown share one row layer, split only because a context menu cannot take a controlled open prop
status: current
updated: 2026-08-28
source: "Menu onto Kobalte DropdownMenu and ContextMenu (personal/sway, branch `103-menu`, skarif2/sway#103), all six phases; commits `b855a3c`, `bfb0014`, `7c610cb`, `a0913d9`, `1827ba1`, `3e0ddc4`; the heading variant from Repository identity on tabs, breadcrumbs, quick-open and menus (branch `feature-workspace`, #158), phase 5, commit `c422394`"
---

# Menu wrappers (ContextMenu, Dropdown, rows)

**Location:** `src/components/Menu/` (key files: `ContextMenu.tsx`, `Dropdown.tsx`, `rows.tsx`, `surface.ts`, `Menu.module.css`), `src/lib/menu.ts`

Sway's two menu surfaces on the `lib/` seam, following [[component_dialog]] and the tooltip wrapper: `ContextMenu` for a right-click row, `Dropdown` for a menu hung off a trigger, both rendering the same rows through `rows.tsx` and the same chrome through one stylesheet. They exist as two components rather than one because Kobalte's two roots are not interchangeable, and as *only* two because everything below the root is shared.

Every menu in the app renders through them. The hand-rolled `Menu.tsx` that composed [[component_popover]] for placement is deleted.

## The call sites

| Surface | Wrapper | Shape |
| --- | --- | --- |
| File tree rows | `ContextMenu` | trigger is the row; `disabled` when the tree is read-only, so the browser's own menu opens |
| Sidebar space tile | `ContextMenu` | wrapped, because the tile is a `Tooltip`'s |
| Sidebar project / branch rows | `ContextMenu` | trigger is the row |
| History panel rows | `ContextMenu` | trigger is the row; `onOpenChange` keeps the enclosing popover open and stands its arrow keys down |
| Editor tab strip | `ContextMenu` | wrapped, and only on the real row (the measuring ghost gets none) |
| Terminal split-button caret | `Dropdown` | wrapped, `bottom-end` |
| `+N` tab overflow | `Dropdown` | wrapped, `bottom-start` |
| Composer pickers (mode, model, effort) | `Dropdown` | wrapped, `top-start`, `closeOnSelect={false}` for a row that pages deeper |
| Breadcrumb crumbs | `Dropdown` | **not** wrapped: a crumb is a plain button, so the trigger is the crumb |
| CodeEditor code actions | `Dropdown` | anchor mode, no trigger at all |

The wrapped ones are wrapped because their control already belongs to a `Tooltip`. Which kind of wrapper, and what each costs, is [[concept_menu_trigger_wrapping]]; the short version is that a context wrapper can be `display: contents` and a dropdown wrapper cannot, and that a dropdown wrapper needs `wrapper` on the `Dropdown` or it becomes a second control around the first.

## Why two wrappers and one row layer

`ContextMenuRootOptions` is `Omit<MenuRootOptions, "open" | "defaultOpen" | "getAnchorRect">`. A context menu is therefore strictly uncontrolled and places itself at the cursor through its own trigger; a dropdown accepts both, which is the only reason a menu with no trigger element at all is possible. That asymmetry is the whole split.

Everything else is literally shared. Kobalte re-exports `Item`, `Separator`, `Portal`, `Sub`, `SubTrigger` and `SubContent` from one internal module under both entry points, so they are the same components reading the same context. `rows.tsx` names one namespace and renders inside either root, with no parameterisation and no context of its own. That is an undocumented detail of a dependency, so `src/lib/menu.test.ts` asserts the identity: a Kobalte release that splits the two families fails there, naming `rows.tsx`, rather than failing later as a missing-context error at a call site.

## Responsibilities

- Owns menu chrome, the row API (`MenuItem`, `MenuRow`, `MenuSeparator`, `MenuSub`, `MenuRows`), non-modal defaults, portalling and the mount every level of a menu inherits, and focus restore for the trigger-less mode.
- Does **not** own placement, dismissal, roving focus, typeahead or `role` semantics. All of that is Kobalte's, which is the point of the migration.
- Does **not** decide what a menu contains. Every call site still builds its own item list in its own handler.
- Does **not** re-export `CheckboxItem`, `RadioItem`, `RadioGroup`, `Icon`, `ItemIndicator`, `ItemLabel`, `ItemDescription` or `Arrow`. The allow-list in `src/lib/menu.ts` stays honest: a part nothing composes reads as supported surface. `Group` and `GroupLabel` came onto it in #158, together, because the heading variant composes them (see below).

## A heading names what the menu is acting on

`MenuItem` has a third variant, `{ heading: string }`. It exists because inside a [[concept_feature_workspace]] two members hold the same `src/index.ts`, and a right-click menu opened over one of them said nothing about which one it was about to rename inside. The tree row menu is the only consumer today; `SearchPanel` and `ReviewPanel` have no context menu at all, which is why #158's "search hits and changed files" clause was split out rather than built.

It renders as Kobalte's `GroupLabel` inside its `Group`, not a styled div. `GroupLabel` is `aria-hidden="true"` with a generated id; `Group` is `role="group" aria-labelledby=<that id>`. So the name is announced once, as the group's name, ahead of the first row, and the arrows and typeahead pass over it because it is not a `menuitem`. A plain div would have had to be read as a row or not read at all.

Two consequences worth knowing before adding one elsewhere:

- **The group appears only when a heading does.** `MenuRows` checks `items.some(it => "heading" in it)` and wraps in `Primitive.Group` only then, splitting its `<For>` into a private `FlatRows` so the same list renders either way without being written twice. An unlabelled `role="group"` around every menu in the app would be structure that says nothing.
- **`MenuHeading` is deliberately unexported**, alone among the rows here. It reads its id from the enclosing group's context and throws without one, and the group is not exported either, so an exported heading would be a component nobody could legally use. Reach it through `items`.

## Non-modal by default

Kobalte defaults `modal: true`, and `preventScroll` defaults to `isModal()`. Accepting that would add a scroll lock, a focus trap and `ariaHideOutside` to nine surfaces that have never had any of them, and the sharpest case is self-defeating: HistoryPanel's row menus live *inside* the popover they belong to, so a modal row menu would aria-hide its own panel. Dismissal does not depend on modality, so the default costs nothing. `modal` is an opt-in prop per site.

## The recipe

Token names only. Values were taken from the reference named in [[adr_solid_ui_reference]], snapped to Sway's ramps, with Sway's density winning where the two disagreed.

| Part | Property | Token |
| --- | --- | --- |
| Surface | padding | `--sway-space-3` |
| Surface | radius | `--sway-radius-xl` |
| Surface | elevation | `--shadow-md` on `--canvas-card`, 1px `--border-default` |
| Row | padding | `--sway-space-3` `--sway-space-4` |
| Row | gap to a leading glyph | `--sway-space-3` |
| Row | radius | `--sway-radius-md` |
| Row | type | `--sway-text-lg` |
| Row | highlight | `--neutral-hover`, on `:hover` **and** `[data-highlighted]` |
| Row | danger / warn | `--danger-fg` / `--attention-fg` |
| Row | disabled | `--fg-muted`, on `[data-disabled]` |
| Separator | rhythm | `--sway-space-2` vertical, `--sway-space-3` inset |
| Heading | padding | `--sway-space-2` `--sway-space-4` |
| Heading | type / role | `--sway-text-md`, `--fg-muted` |
| Trigger gutter | offset | 4px, a JS number (see below) |
| Cursor gutter / shift | offset | 2px / 2px, Kobalte's own context-menu values |
| Flyout | surface | the same `.content` class as its parent |
| Flyout | opener row | the same `.item` class, plus `[data-expanded]` held at `--neutral-hover` |
| Flyout | indicator | a chevron at the trailing edge by its own auto margin, `--fg-subtle` |
| Flyout gutter / shift | offset | 10px / -6px, JS numbers (see below) |

Two things the table cannot carry:

- **The row's vertical padding moved.** It was a bare `5px`; it is now `--sway-space-3` (6px), which is both on the ramp and the reference's own value. This is the one place the migration changed a shipped proportion, and it was changed because the row stopped being a `div` and became a real menu item.
- **Gutters are not tokens and cannot be.** Kobalte hands them to floating-ui as numbers, so they never reach CSS and cannot read `--ui-scale`. Recorded here as literals for that reason. The flyout's two are derived rather than picked: 10 is the surface's own 6px padding plus the 4px a dropdown clears its button by, because the row a flyout is measured from is inset by that padding, and -6 undoes the padding on the other axis so a flyout's first row lines up with the row that opened it. jsdom gives floating-ui no geometry, so these are reviewable and not testable, and the derivation in the comment is the only guard they have.

## Considered and rejected from the reference

- **A full-bleed separator.** The reference pulls the rule past the surface's own padding so it spans edge to edge. Sway keeps its inset rule: against a `--sway-radius-xl` container, a full-bleed rule runs into the curve.
- **`opacity` for a disabled row.** A role is theme-correct and an opacity is not, so `--fg-muted` instead.
- **`transform-origin` from Kobalte's popper variable.** Earns its keep only with an open/close animation, and there is none.
- **The reference's proportions wholesale.** Its item gap and minimum width are web-app airy; [[adr_premium_design_system]]'s dense tier undercuts both.

## Key files & entry points

- `src/lib/menu.ts` - the two namespace objects, aliased on import because every part name collides with its opposite number.
- `src/lib/menu.test.ts` - asserts the eight shared parts are shared and the three unshared ones are not; `Group` and `GroupLabel` joined the loop in #158 and come from the same internal module as `Item`.
- `src/components/Menu/rows.tsx:17` - `MenuItem`, `MenuRow`, `MenuSeparator`, `MenuRows`, `MenuSub`, and the unexported `MenuHeading`/`FlatRows` pair. `disabled` is passed to the primitive, not painted as a class, which is what also makes it block activation and skip arrow navigation.
- `src/components/Menu/ContextMenu.tsx` - trigger-is-the-row, `as` takes a tag name for the reason the tooltip's does. Exposes `onOpenChange` so an enclosing surface can track an open row menu.
- `src/components/Menu/Dropdown.tsx` - trigger mode, `anchor={{x,y}}` mode, and the `wrapper` prop. `cursorRect` is exported solely so the mapping has a guard.
- `src/components/Menu/surface.ts` - the mount a menu's levels inherit, published by whichever wrapper opened it.
- `src/components/Menu/Menu.module.css` - one block now. Five classes: `.content`, `.item`, `.subInto`, `.separator`, `.heading`.
- `src/test/menuIdioms.test.ts` - the guard for the two test idioms this migration swept, in the shape of [[concept_named_exemption_guard]].

## A flyout is a level, and levels are lazy

`MenuSub` ships the four Kobalte parts (`Sub`, `SubTrigger`, `Portal`, `SubContent`) as one component rather than four exports, because they are never composed apart and the `Portal` is the one that carries meaning: it renders its children only while that level is open. That is what makes a per-level `createResource` fetch one folder per folder opened rather than the whole tree at once, and a call site free to leave it out would lose that silently.

`SubTrigger` is a `role="menuitem"` like any other row and carries the row class, because a flyout's opener is not a different kind of row, it is a row that leads somewhere. Kobalte writes `aria-haspopup` and `aria-expanded` on it and closes the whole stack when a row anywhere inside is picked, so nothing needs `closeOnSelect`.

Breadcrumbs is the only consumer, and the reason the layer exists: its folder picker used to replace the open list in place, so the level you came from left the screen and the only way back was Escape.

## The virtual anchor is Kobalte's own context menu, restated

`Dropdown`'s `anchor` mode exists for one surface: CodeEditor's code-action menu, where the caret is not an element. Kobalte builds its context menu exactly this way internally, a `{x, y}` signal handed straight to `getAnchorRect` with `placement: "right-start"`, `gutter: 2`, `shift: 2`, so the wrapper uses those numbers rather than inventing offsets and a caret menu reads like a right-click menu.

Focus restore in that mode is Sway's, for the reason [[component_dialog]]'s is: on close Kobalte focuses its trigger, and here there is none, so its restore is a no-op and focus lands on `<body>`. The element focused at open is captured in `onOpenAutoFocus` and restored in `onCloseAutoFocus`. Trigger mode needs none of it.

## Connections

- Sits on [[component_lib_boundary]] - `src/lib/menu.ts` is the third module on that seam, and the first to re-export two primitives side by side, which is what makes the aliasing necessary.
- Follows [[component_dialog]] - same wrapper shape, same focus-restore pattern, and portals into its panel through `src/components/Dialog/surface.ts`.
- Replaced the menu half of [[component_popover]] - #104 owns Popover itself, which survives this ticket as HistoryPanel's only.
- Absorbed [[component_context_menu]]'s primitive and [[component_overflow_tab_bar]]'s dropdown.
- [[concept_menu_trigger_wrapping]] is the rule for the five sites that could not be their own trigger.
- Governed by [[adr_headless_primitives]] and [[adr_solid_ui_reference]]; overridden on density by [[adr_premium_design_system]].

## Related

- [[concept_repository_identity]] - what the heading variant was added for, and every other surface that says the same thing

- [[gotcha_a_kobalte_menu_answers_no_plain_click]] - triggers open on `pointerdown`, rows act on `pointerup`, and `src/test/menus.ts` exports `pointerClick` for it.
- [[gotcha_vitest_stubs_css_imports_to_the_empty_string]] - why the highlight recipe above has no test behind it, only the attribute that drives it.
- [[gotcha_axe_cannot_judge_a_dropdown_trigger_in_any_browser]] - `aria-valid-attr-value` raises `controlsWithinPopup` for anything carrying both `aria-haspopup` and `aria-controls`.
- [[gotcha_kobalte_reports_no_close_for_a_trigger_that_unmounts]] - track the open row by id and clear it from that row's own `onCleanup`.
- [[gotcha_a_menus_flyout_is_a_separate_portal]] - why the mount is published rather than resolved per part.
- [[lesson_a_wrapper_is_a_control_until_told_otherwise]] - how the `wrapper` prop came to exist, two phases after it was needed.
- [[concept_design_token_system]] - the ramps the recipe above is snapped to, and the guard that keeps the colours honest.
