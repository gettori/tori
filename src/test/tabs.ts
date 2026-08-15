import { screen } from "@solidjs/testing-library";

/**
 * A tab from an `OverflowTabBar` strip, by its accessible name.
 *
 * The bar measures true tab widths with an inert copy of the whole strip,
 * `aria-hidden` so nothing reads it twice, and in jsdom that ghost is usually
 * the *only* copy: the bar seeds its visible count from the item list at mount,
 * which is empty, and corrects it in an `onMount` `requestAnimationFrame` that
 * jsdom never runs. So the count stays at zero and every tab overflows. Hence
 * `hidden: true`, which looks past `aria-hidden`, and the first match.
 *
 * Clicking the ghost still works - it is the same `renderTab` output, handlers
 * and all - so a test that reaches a tab this way is testing the real control,
 * just not the copy a browser would have drawn.
 *
 * **Not for anything about the tab's context menu**, which the ghost no longer
 * has: see `visibleTab` below.
 */
export function tab(name: string | RegExp): HTMLElement {
  return screen.getAllByRole("tab", { name, hidden: true })[0];
}

/** The same lookup, for asserting a tab is *not* there. Empty when it is gone. */
export function tabs(name: string | RegExp): HTMLElement[] {
  return screen.queryAllByRole("tab", { name, hidden: true });
}

/**
 * The tab the browser would actually draw, skipping the measuring ghost.
 *
 * Use this, not `tab()`, for anything about the tab's *context menu*. The ghost
 * is rendered menu-free on purpose (skarif2/sway#103 phase 4): mounting a menu
 * per tab twice doubles the machinery for a row nobody can reach, and leaves two
 * triggers claiming the same tab. So a right-click on `tab()` now asks a copy
 * that has nothing to answer with, which reads as "the menu is broken".
 *
 * **Needs `installAnimationFrame()`** (see the editor harness), or there is no
 * visible copy to find at all. With it, there is exactly one: every measured
 * width is 0, so `computeVisibleCount` falls through to its "always show at
 * least one" floor, and `displayOrder` pulls the *active* tab into that slot.
 * Reaching a non-active tab this way is therefore not possible, and wanting one
 * is a sign the test wants `tab()` instead.
 */
export function visibleTab(name: string | RegExp): HTMLElement {
  return screen.getByRole("tab", { name });
}
