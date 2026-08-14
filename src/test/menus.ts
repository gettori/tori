// Helpers for the right-click surfaces, shared across the panels that have one
// (the file tree, the sidebar's three levels, the editor's tab strip).
//
// These exist because of skarif2/sway#103, which moves every menu onto Kobalte:
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
