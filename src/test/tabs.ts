import { screen } from "@solidjs/testing-library";

/**
 * A tab from an `OverflowTabBar` strip, by its accessible name.
 *
 * This is the visible row: the copy a browser draws, the one carrying the
 * context menu, and the only one that will still be a tab once the strip moves
 * onto Kobalte (skarif2/sway#111). It used to be the measuring ghost, reached
 * with `hidden: true`, because jsdom measured every width as 0 and the bar kept
 * exactly one tab on screen. `src/test/tabLayout.ts` gives the bar a real width
 * instead, so the visible row holds what it would hold in a browser.
 *
 * **Needs the measurement frame to have landed.** The bar seeds its visible
 * count from the item list it was created with (empty, in a panel that opens
 * tabs later) and corrects it in a `requestAnimationFrame`. Either call
 * `installAnimationFrame()` from the editor harness, or wrap the lookup in
 * `waitFor`/`findBy`.
 */
export function tab(name: string | RegExp): HTMLElement {
  return screen.getByRole("tab", { name });
}

/** The same lookup, for asserting a tab is *not* there. Empty when it is gone.
 *
 *  Absence here means "not drawn", which is only the same as "not open" while
 *  the bar is wide enough to draw everything. It is, by default; a test that
 *  narrows it with `setTabBarWidth` is asking a different question. */
export function tabs(name: string | RegExp): HTMLElement[] {
  return screen.queryAllByRole("tab", { name });
}

/** A named tab's close button.
 *
 *  Reached by attribute rather than by label, because the close is hidden from
 *  assistive tech and so has no accessible name to query: `role="tablist"` may
 *  own nothing but tabs, so a labelled button beside the trigger fails axe.
 *  Delete or Backspace on the focused tab is the path that *is* announced, and
 *  the one a keyboard test should use. See `src/components/Tab/Tab.tsx`.
 *
 *  The close is a sibling of the trigger inside the pill, not a child of it,
 *  which is why this steps up before it looks down. */
export function closeOf(name: string | RegExp): HTMLElement {
  const el = tab(name).parentElement?.querySelector<HTMLElement>("[data-tab-close]");
  if (!el) throw new Error(`the tab matching ${String(name)} has no close button`);
  return el;
}
