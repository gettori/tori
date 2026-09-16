---
summary: Kobalte puts tooltip behavior on the trigger, so Tooltip renders the control instead of wrapping one, title banned
status: current
updated: 2026-08-15
source: "plan \"Tooltip primitive and the `title=` sweep\" (personal/sway, branch `102-tooltip-primitive`, issue #102, part of #93); `src/components/Tooltip/Tooltip.tsx`, `src/components/Dialog/surface.ts`, `src/lib/tooltip.ts`, `src/test/interactiveTitle.test.ts`; commits c996ca9, 9826e7e, 51771df, a23d8f4, dbfa12a; extended by plan \"Dedupe icon and swatch grids into one IconGrid\" (branch `109-dedupe-icon-and-swatch-grids`, issue #109); commit cd09a5e; PR #138"
---

# The tooltip trigger is the control

A native `title` is a mouse-only tooltip: it never appears for a keyboard user, it is not exposed as a description by every screen reader, and it cannot be styled. #102 replaced all 134 interactive ones with a Kobalte-backed `Tooltip` and then made the native attribute a **type error** on `Button`, `IconButton`, `Tab` and `Tooltip` itself. The single decision the whole design turns on is in the title: Kobalte puts every tooltip behaviour on the trigger *element*, so the trigger has to be the control, which is why `Tooltip` renders the control rather than accepting one.

## How it works

**`as` takes a host to render, never a constructed element.** `Tooltip.Trigger`'s polymorphic `as` accepts a component or a tag; a Solid JSX element is already-built DOM and nothing can inject the trigger's props into it afterwards. So `<Tooltip as="button" label=… >` renders the button, and Sway's own controls compose it **from the inside** (`Button` renders `<Tooltip as="button" …>`, not `<Tooltip><Button/></Tooltip>`). A raw element gets the standalone form.

**A tag name was the only host until #109, and now a component is one too.** The case that forced it: a control that *is* a headless primitive's part, so it exists only under that primitive's context and cannot be built from the inside the way `Button` is. [[component_icon_grid]]'s tiles are `ToggleGroup.Item`s that also need a tooltip, and the outward-in trick below does not reach them, since there is no Sway control in between to render `as="button"`. `Tooltip`'s props are generic over the host (`TooltipProps<T, P>`, `as?: keyof JSX.HTMLElementTags | Component<P>`), so the host's own required props are demanded at the call site.

That genericity is the whole point rather than a nicety. Widening `as` alone would leave the prop surface pinned to `ButtonHTMLAttributes`, which already declares an optional `value` of its own, so `<Tooltip as={ToggleGroup.ButtonItem}>` with no `value` would compile and every tile would register under the same undefined key. Inference also needs a *concrete* component on the other side, see [[gotcha_a_generic_polymorphic_component_cannot_be_inferred_from]].

**A third primitive can reach the same button, from further out.** #108 needed a control that is a Kobalte toggle item *and* a tooltip trigger. Composing outward-in through polymorphism gets both onto one element: `<ToggleGroup.Item as={IconButton} tooltip=…>` hands the item's props (pressed state, roving tabindex, `disabled`, the toggling click) to `IconButton`, which is already `<Tooltip as="button">`, so the toggle item, the trigger and the control are the same `<button>`. Nothing here contradicts the rule above, it is the rule applied one layer further out, and it is why the answer was never a `<Tooltip>` wrapped around a `<ToggleGroup.Item>`. `whenDisabled`'s hover-surface `span` still sits outside that button and still works, which is the part worth pinning in a test. See [[component_toggle_group]].

**The no-label fast path is load-bearing.** With no `label`, `Tooltip` renders a bare `Dynamic` with none of Kobalte's context, popper or portal (`Tooltip.tsx`). Without it, each of the three controls would need two render branches and the drift between them — and most of the app's several hundred buttons pass no tooltip at all.

**A tooltip is a description, never a name.** Kobalte wires `aria-describedby`, which is announced after the name and skipped by some verbosity settings. 101 of the swept sites had no `aria-label` — the `title` *was* the name — so `Button` (when icon-only) and `IconButton` backfill `aria-label` from `tooltip`. `Tooltip` itself cannot: it does not know whether its trigger has visible text. `Tab` deliberately does not either, see below.

**The mount seam is a context, not a call-site prop.** `Dialog.Content` calls Kobalte's `createHideOutside`, which aria-hides everything outside the panel, so a body-portalled tooltip inside a modal is painted on screen and invisible to assistive tech at the same time. `Dialog` publishes its panel through `src/components/Dialog/surface.ts` and `Tooltip` defaults `mount` to it, which is why the six `components/Dialogs` sites needed nothing but to be inside a `Dialog`. The explicit `mount` prop remains an override.

**Delays are the whole grouping mechanism.** Open 500 (Kobalte's 700 is what "the tooltips are slow" means on a toolbar), close 300, skip 300. The skip-delay timer is module-global inside Kobalte, so every tooltip sharing these values *is* the grouping.

**`whenDisabled` is opt-in per site.** A `disabled` button fires no pointer events and takes no focus, so its tooltip is unreachable by any route ([[gotcha_a_disabled_control_cannot_show_a_tooltip_without_an_enabled_wrapper]]). Setting it wraps the control in a hover-surface `span` driving a controlled `open` on its own timer. That changes DOM shape, so it ships per site with a stated reason — roughly fifteen across the app, each one where the label answers *why is this greyed out?* rather than *what does this do?*. A disabled control left plain loses the hover text a native `title` used to give it; that trade was made deliberately.

**The type is the enforcement, the guard is the backstop.** All four components `Omit<…, "type" | "title">`, so a `title=` on any of them fails `tsc`. `src/test/interactiveTitle.test.ts` covers what the type cannot see — a native title on a raw element — via [[concept_named_exemption_guard]]. Its companion check, that `tooltip=` is only written on a component implementing it, reads the tag name, so #108 taught it to resolve through `as={X}`: under polymorphism the tag a prop is written on is not the component that has to implement it.

## Why it's this way

The wrapper-as-trigger design was drafted first and broken against Kobalte's source before any code was written: `TooltipTrigger` splits `["ref","onPointerEnter","onPointerLeave","onPointerDown","onClick","onFocus","onBlur"]` off the props and composes them on the element it renders. Solid does not delegate `focus`, and `focus` does not bubble, so a trigger wrapped *around* a control receives neither the description nor the keyboard opening — it would look right on hover and be dead on the keyboard, which is precisely the defect being fixed.

`Tab` not backfilling `aria-label` is the one asymmetry, and it is forced: an `aria-label` on a tab *replaces* its visible text as the accessible name ([[gotcha_an_aria_label_on_a_tab_replaces_its_accessible_name]]), so backfilling the full path would rename every tab in the app. The exception is an icon-only tab, which has no text to replace.

`Tooltip` is button-shaped and stays so. `as="input"` was tried and reverted: the props extend `ButtonHTMLAttributes`, so `placeholder` is a type error, and an interface extending both `ButtonHTMLAttributes` and `InputHTMLAttributes` is rejected outright (TS2320) because they declare the same names at different types. The three `<label>`/`<input>` sites took `aria-describedby` plus a visually-hidden hint instead — better anyway, since a `<label>` takes no focus and a tooltip on one would open on hover and never on the keyboard, the same half-measure the `title` was.

## Related

- [[component_lib_boundary]] — `src/lib/tooltip.ts`, the seam it composes
- [[component_dialog]] — publishes the panel the `mount` seam reads
- [[component_tooltip]] — the other half of this surface: the recipe, the composition, and why the motion only goes one way
- [[component_icon_grid]] — the control that forced `as` to take a component
- [[adr_headless_primitives]] — the decision this implements
- [[concept_named_exemption_guard]] — what stops a new `title=` appearing
- [[concept_axe_accessibility_gate]] — where the swept panels are judged, and what it cannot see
- [[gotcha_a_disabled_control_cannot_show_a_tooltip_without_an_enabled_wrapper]]
- [[gotcha_kobalte_writes_aria_hidden_a_timeout_and_a_frame_after_mount]]
