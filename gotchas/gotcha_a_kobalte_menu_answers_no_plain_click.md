---
summary: a kobalte menu opens on pointerdown and selects on pointerup or key, so fireEvent.click reaches neither
status: current
updated: 2026-08-15
source: Menu onto Kobalte DropdownMenu and ContextMenu, phase 2 (personal/sway, branch `103-menu`); `src/test/menus.ts`; [[component_menu]]; _2026-08-15_; guard added in phase 6; `src/test/menuIdioms.test.ts`; commit `3e0ddc4`
---

# A Kobalte menu answers no plain click

Do NOT drive a Kobalte menu with `fireEvent.click`. A trigger opens on `pointerdown`; a row runs its `onSelect` from `pointerup` with `button === 0`, or from Enter/Space. A bare click reaches both and changes neither, so the failure reads as "the menu did not open" or "the action did not fire" rather than as the wrong event, and it costs a debugging session per surface. Every pre-Kobalte menu in Sway was a plain `div` or `button` with an `onClick`, so **every** existing test drives these surfaces the wrong way and has to move as its surface migrates. Use `pointerClick(el)` from `src/test/menus.ts`, which sends down, up, then click.

The sweep is finished and guarded: `src/test/menuIdioms.test.ts` fails on a `fireEvent.click` whose line names a menu role, and on a `fireEvent.mouseDown` with no `pointerDown` beside it (dismissal is the *other* half of the same migration, see [[gotcha_kobalte_defers_its_outside_pointerdown_listener_and_its_unmount_auto_focus_to_a_settimeout_0]]). Two lone `mouseDown`s are exempt by name with reasons, and a third test fails if an exemption outlives what it exempts.
