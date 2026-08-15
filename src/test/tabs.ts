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
