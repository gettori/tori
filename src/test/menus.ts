// Helpers for the right-click surfaces, shared across the panels that have one
// (the file tree, the sidebar's three levels, the editor's tab strip).

/**
 * Right-click `el`, and report whether it claimed the event.
 *
 * The return value is the contract, not a detail: a row that answers with its
 * own menu calls `preventDefault`, and a row that has nothing to offer leaves
 * the event alone so the browser's own menu still opens. `fireEvent.contextMenu`
 * can report the same thing, but only as an unnamed boolean at the call site.
 */
export function rightClick(el: HTMLElement): boolean {
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

/**
 * Click `el` the way a mouse does: down, up, then click.
 *
 * **Nothing in a menu responds to `fireEvent.click` alone.** A trigger opens on
 * `pointerdown`; a row runs its action on `pointerup` with `button === 0` (or on
 * Enter/Space from the keyboard). A bare click reaches both and changes neither,
 * which reads as "the menu did not open" or "the action did not fire" rather
 * than as a wrong event.
 */
export function pointerClick(el: HTMLElement): void {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}
