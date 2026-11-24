---
summary: one stack in src/lib/layer.ts owns Escape, outside press, focus return, scroll lock and exit motion for every overlay
status: current
updated: 2026-11-21
source: solid-2-stage-a-own-primitives plan; gettori/tickets#106; epic gettori/tickets#105; src/lib/layer.ts
---

# Layer module

`src/lib/layer.ts` is the shared behaviour under Dialog, Popover, menus, Select, Combobox and Tooltip. Components own their markup and call it.

## Responsibility

- **One stack.** `openLayer` (`src/lib/layer.ts:188`) pushes a layer and returns its release. Escape and an outside press reach the topmost layer only.
- **Escape** is a bubble phase `keydown` on `document` that skips an event already prevented, so a control inside a layer can take it first. The dialog's `cancel` is only a backstop, because Android's close watcher can deliver it as not cancelable.
- **Outside press** is a capture `pointerdown`. A layer can name `ignorePress`, or keep focus where the press put it with `keepFocusOnPress`.
- **Passive layers** (tooltips) take Escape but no press and no focus. A `closing` layer, in its exit animation, answers no input.
- **Focus return** runs after `hide`, because focus moved while a modal is still open is lost to inertness. `returnFocus` returning null restores nothing.
- **Scroll lock** is counted, so stacked modals release it once.
- **Placement** is CSS only: `anchorLayer` writes a unique `anchor-name` per instance, and `pointAnchor` makes a zero size fixed element for a menu at the pointer.
- **Presence.** `createPresence` (`src/lib/layer.ts:316`) holds a closing node with `data-closed` until its animation ends. It unmounts at once when there is no animation or the enter and exit share a name, and a timer covers a window that is not painting.
- **`watchTopModal`** tells the toast region which modal is on top.

It does not own markup, styling, or keyboard movement inside a layer. That is [[component_keyboard_helpers]].

## Interface

`openLayer` takes `show` and `hide`, so the order is fixed: note focus, show, and on release hide, then move focus. Call it from an effect in a component inside the `Portal`, because `showModal` and `showPopover` throw on a node that is not connected.

## Related

- [[adr_own_primitives_on_native_layers]] the decision and the spike behind it
- [[component_dialog]] the modal consumer
- [[component_lib_boundary]] what `src/lib` holds now
- [[gotcha_moving_a_popover_drops_it_from_the_top_layer]] the trap in the toast region
- [[gotcha_webkit_sends_a_pressed_buttons_focus_to_its_focusable_ancestor]] why the layer ignores focus until the opening press ends
