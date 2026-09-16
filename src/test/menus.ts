// Helpers for the right-click surfaces, shared across the panels that have one
// (the file tree, the sidebar's three levels, the editor's tab strip).
//
// These exist because of gettori/tori#103, which moves every menu onto Kobalte:
// the tests that pin today's behaviour and the tests that will assert the
// migrated behaviour have to ask the same questions, or the migration is
// guarded by assertions that quietly changed meaning along with the code.

/**
 * Right-click `el`, and report whether it claimed the event.
 *
 * The return value is the contract, not a detail: a row that answers with its
 * own menu calls `preventDefault`, and a row that has nothing to offer leaves
 * the event alone so the browser's own menu still opens. `fireEvent.contextMenu`
 * can report the same thing, but only as an unnamed boolean at the call site.
 *
 * Survives the Kobalte migration by construction. `ContextMenu.Trigger` calls
 * `preventDefault` for every right-click unless it is `disabled`, in which case
 * it returns before doing so, which is exactly the distinction asserted here.
 */
export function rightClick(el: HTMLElement): boolean {
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

/**
 * Click `el` the way a mouse does: down, up, then click.
 *
 * **Nothing in a Kobalte menu responds to `fireEvent.click` alone.** A trigger
 * opens on `pointerdown`; a row runs its action on `pointerup` with
 * `button === 0` (or on Enter/Space from the keyboard). A bare click reaches
 * both and changes neither, which reads as "the menu did not open" or "the
 * action did not fire" rather than as a wrong event.
 *
 * The surfaces being migrated were plain `div`s and `button`s with `onClick`
 * handlers, so every pre-migration test drives them with `fireEvent.click`.
 * Each of those has to move to this helper as its surface migrates, and that is
 * the single largest mechanical change phases 3 and 4 carry.
 */
export function pointerClick(el: HTMLElement): void {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}
