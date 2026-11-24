---
summary: src/lib/keyboard.ts holds roving focus, DOM ordered keys and typeahead, shared by menus, lists, tabs and toggles
status: current
updated: 2026-11-21
source: solid-2-stage-a-own-primitives plan; gettori/tickets#106; epic gettori/tickets#105; src/lib/keyboard.ts
---

# Keyboard helpers

`src/lib/keyboard.ts` is the shared keyboard model for composite widgets.

## Responsibility

- `createRovingFocus` (`src/lib/keyboard.ts:64`) gives one tab stop across a group. Consumers spread `roving.root` on the group and `roving.item(key)` on each item. Keys are reactive strings, so a focused item leaving `keys` gives up the tab stop synchronously.
- `createItemOrder` (`src/lib/keyboard.ts:31`) keeps enabled keys in DOM order for items that register themselves, and re-sorts through a MutationObserver.
- `createTypeahead` (`src/lib/keyboard.ts:146`) resets after 500ms and searches from the current item inclusive. Repeating a letter does not cycle.

## Interface

`ToggleGroup` and `Tabs` use roving focus. `Select` and `menuCore` use typeahead. A menu does not rove: focus starts on its container with no row active, and it has no tab stop.

`rootTabStop` makes the group hold the stop until an item takes focus, as a toggle group needs. Without it the selected item holds the stop, as tabs need. `wrap` is off by default.

## Related

- [[component_layer]] the dismissal and focus layer these sit beside
- [[component_toggle_group]] a consumer
- [[component_tab]] a consumer
