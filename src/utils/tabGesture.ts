// The gesture half of the overflow tab bar: which event, if any, the bar is
// handling right now, and whether that event is a user selecting a tab. The bar
// owns the DOM listeners; this owns the lifetime and the exclusions.

/** Keys that close the focused tab, which `Tab` handles itself. */
const CLOSE_KEYS = new Set(["Delete", "Backspace"]);

/**
 * A gesture that lives exactly as long as the browser is dispatching it.
 *
 * The bar marks an event in the capture phase and reads `live()` later, from
 * inside a handler Kobalte owns. Both halves are subtle enough to be worth
 * naming:
 *
 * **The lifetime is the dispatch, not a timer.** A flag cleared in a
 * `queueMicrotask` looks like it covers the handler chain and does not: the
 * browser runs a microtask checkpoint after *every* listener callback of a
 * user-initiated dispatch, so the flag is already gone one listener later.
 * Kobalte's handlers are JSX props, which Solid delegates to a single
 * `document` listener, so they run several checkpoints after anything captured
 * on the bar - and a scripted `fireEvent` keeps the JS stack busy, which is why
 * jsdom never sees any of this. Reading `eventPhase` asks the event itself, so
 * there is no window to get wrong and nothing to clean up.
 *
 * **A close keystroke is not a selection.** Delete and Backspace on a focused
 * tab close it, and closing writes the tab list before the panel has picked
 * what comes next, which is the render where Kobalte force-selects the leftmost
 * key. Solid does not batch a delegated handler, so that heal lands while the
 * keystroke is still dispatching; without this exclusion the bar would read it
 * as the user asking for the leftmost tab.
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
