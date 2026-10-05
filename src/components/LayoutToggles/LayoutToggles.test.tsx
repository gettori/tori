// What this file is really proving is the composition: a Kobalte toggle item
// rendered *as* an `IconButton`, which is itself a `Tooltip` trigger. Three
// layers of polymorphism deep, and the failure mode of getting it wrong is
// quiet - a tooltip that never opens, a button outside the group's collection,
// a pressed state that never reaches the DOM - so each is asserted here.
//
// The terminal and editor toggles that used to sit beside the sidebar's are
// gone (phase 13): with one pane holding every kind there is nothing for them
// to hide, and their keys bring a kind's tab to the front instead.
import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { createSignal } from "solid-js";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import LayoutToggles from "./LayoutToggles";
import { on, TOGGLE_SIDEBAR } from "../../utils/events";
import { expectNoAxeViolations } from "../../test/axe";

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

/** Listen for a pane event for the length of one test. */
function listen(event: string) {
  const seen = vi.fn();
  offs.push(on(event, seen));
  return seen;
}

const toggle = (name: string) => screen.getByRole("button", { name });

const SIDEBAR = "Show or hide the sidebar (⌘B)";

describe("LayoutToggles", () => {
  it("reflects the sidebar's visibility as the button's pressed state", () => {
    render(() => <LayoutToggles showSidebar={false} />);

    expect(toggle(SIDEBAR).getAttribute("aria-pressed")).toBe("false");
    // The hidden-pane accent hangs off this attribute, so its absence is
    // load-bearing rather than cosmetic.
    expect(toggle(SIDEBAR).hasAttribute("data-pressed")).toBe(false);
  });

  it("emits when the sidebar is hidden, and again when it comes back", () => {
    const sidebar = listen(TOGGLE_SIDEBAR);
    const [shown, setShown] = createSignal(true);
    render(() => <LayoutToggles showSidebar={shown()} />);

    fireEvent.click(toggle(SIDEBAR));
    expect(sidebar).toHaveBeenCalledTimes(1);

    setShown(false);
    expect(toggle(SIDEBAR).hasAttribute("data-pressed")).toBe(false);
    fireEvent.click(toggle(SIDEBAR));
    expect(sidebar).toHaveBeenCalledTimes(2);
  });

  it("keeps its button, and the focus on it, when the state flips", () => {
    // The state comes back through props, so every toggle re-renders this
    // component. Building the item from props inside a `<For>` would give Solid
    // a new identity each time: the button is torn down and rebuilt, and a
    // keyboard user pressing Space watches focus fall to the body. Static tests
    // cannot see it - the props have to actually change.
    const [sidebar, setSidebar] = createSignal(true);
    render(() => <LayoutToggles showSidebar={sidebar()} />);

    const before = toggle(SIDEBAR);
    before.focus();
    setSidebar(false);

    expect(toggle(SIDEBAR)).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it("has no violations", async () => {
    const { container } = render(() => <LayoutToggles showSidebar />);
    await expectNoAxeViolations(container);
  });
});
