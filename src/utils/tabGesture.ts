// The gesture half of the overflow tab bar: which event, if any, the bar is
// handling right now, and whether that event is a user selecting a tab. The bar
// owns the DOM listeners; this owns the lifetime and the exclusions.

/** Keys that close the focused tab, which `Tab` handles itself. */
const CLOSE_KEYS = new Set(["Delete", "Backspace"]);

/**
 * A gesture that lives exactly as long as the browser is dispatching it.
 *
 * A browser runs a microtask checkpoint after every listener of a real event,
 * so a flag cleared in a microtask is gone before Solid's delegated handler
 * runs. jsdom hides this, so the lifetime is read from `eventPhase` instead.
 */
export function tabGesture() {
  let current: Event | null = null;

  return {
    /** Record `e` if it is a selection gesture on a tab, and nothing otherwise. */
    mark(e: Event) {
      current = isSelectionOnTab(e) ? e : null;
    },
    /** Whether the marked gesture is still being dispatched. Drops a finished
     *  event on the way, so a closed tab's node is not held by its own last
     *  keystroke until the next gesture arrives. */
    live() {
      if (current != null && current.eventPhase === Event.NONE) current = null;
      return current != null;
    },
  };
}

function isSelectionOnTab(e: Event): boolean {
  if (e instanceof KeyboardEvent && CLOSE_KEYS.has(e.key)) return false;
  return !!(e.target as Element | null)?.closest?.('[role="tab"]');
}
