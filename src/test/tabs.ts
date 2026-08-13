import { screen } from "@solidjs/testing-library";

/**
 * A tab from an `OverflowTabBar` strip, by its accessible name.
 *
 * The bar measures true tab widths with an inert copy of the whole strip,
 * `aria-hidden` so nothing reads it twice. jsdom gives that bar no geometry, so
 * every measured width is 0 and the visible row keeps almost nothing: for most
 * tabs the ghost is the only copy in the document. Hence `hidden: true`, which
 * looks past `aria-hidden`, and the first match, which is the ghost's.
 *
 * Clicking the ghost still works - it is the same `renderTab` output, handlers
 * and all - so a test that reaches a tab this way is testing the real control,
 * just not the copy a browser would have drawn.
 */
export function tab(name: string | RegExp): HTMLElement {
  return screen.getAllByRole("tab", { name, hidden: true })[0];
}

/** The same lookup, for asserting a tab is *not* there. Empty when it is gone. */
export function tabs(name: string | RegExp): HTMLElement[] {
  return screen.queryAllByRole("tab", { name, hidden: true });
}
