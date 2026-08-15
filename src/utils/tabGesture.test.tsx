import { describe, it, expect, afterEach } from "vitest";
import { tabGesture } from "./tabGesture";

// A `.test.tsx` with no JSX in it, deliberately: the file extension is what
// picks the environment (see vitest.config.ts), and every assertion here is
// about a real event travelling through a real DOM. The unit project runs in
// node, where there is no `Event` to dispatch at all.

function strip() {
  const bar = document.createElement("div");
  bar.innerHTML = `
    <span><button role="tab">one</button><button data-tab-close="">x</button></span>
    <button role="tab">two</button>`;
  document.body.append(bar);
  return {
    bar,
    tab: bar.querySelectorAll<HTMLElement>('[role="tab"]')[0],
    close: bar.querySelector<HTMLElement>("[data-tab-close]")!,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tabGesture", () => {
  it("stays live for the whole dispatch, and dies with it", () => {
    // The bug this replaces: the flag was cleared in a `queueMicrotask`, and a
    // browser runs a microtask checkpoint after every listener callback of a
    // user-initiated dispatch. So it was already gone by the time Kobalte's own
    // handler ran, and clicking a tab did nothing in the app while every
    // `fireEvent` test passed. Reading the event's own phase has no window.
    const g = tabGesture();
    const { bar, tab } = strip();
    let seenLater: boolean | null = null;

    bar.addEventListener("click", (e) => g.mark(e), true);
    // Stands in for Kobalte's handler, which Solid delegates to `document` and
    // therefore runs after everything on the bar.
    document.addEventListener("click", () => (seenLater = g.live()), { once: true });

    tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(seenLater).toBe(true);
    expect(g.live()).toBe(false);
  });

  it("does not read a close keystroke as a selection", () => {
    // Delete and Backspace on a focused tab close it, and a close writes the tab
    // list before the panel has picked what comes next - the one render where
    // Kobalte force-selects the leftmost key. Solid does not batch a delegated
    // handler, so that heal arrives while this very keystroke is still
    // dispatching, and a bar that trusted it would open the leftmost tab.
    const g = tabGesture();
    const { bar, tab } = strip();
    const seen: Record<string, boolean> = {};

    bar.addEventListener("keydown", (e) => g.mark(e), true);
    document.addEventListener("keydown", (e) => {
      seen[(e as KeyboardEvent).key] = g.live();
    });

    for (const key of ["Delete", "Backspace", "Enter"]) {
      tab.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }

    expect(seen).toEqual({ Delete: false, Backspace: false, Enter: true });
  });

  it("is not live for a gesture that missed the tabs", () => {
    // The close button is a sibling of the trigger, so a press on it has no tab
    // above it. That is what makes closing by pointer land on the panel's choice
    // rather than on the heal.
    const g = tabGesture();
    const { bar, close } = strip();
    let seenLater: boolean | null = null;

    bar.addEventListener("click", (e) => g.mark(e), true);
    document.addEventListener("click", () => (seenLater = g.live()), { once: true });

    close.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(seenLater).toBe(false);
  });
});
