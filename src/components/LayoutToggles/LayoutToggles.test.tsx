// What this file is really proving is the composition: a Kobalte toggle item
// rendered *as* an `IconButton`, which is itself a `Tooltip` trigger. Three
// layers of polymorphism deep, and the failure mode of getting it wrong is
// quiet - a tooltip that never opens, a button outside the group's collection,
// a pressed state that never reaches the DOM - so each is asserted here.
import { describe, expect, it, vi, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import LayoutToggles from "./LayoutToggles";
import { on, TOGGLE_SIDEBAR, TOGGLE_TERMINAL, TOGGLE_EDITOR } from "../../utils/events";
import { expectNoAxeViolations } from "../../test/axe";

const ALL_SHOWN = { showSidebar: true, showTerminal: true, showEditor: true };

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

// Exact names, not substrings: a blocked pane's reason names *both* panes
// ("Can't hide the terminal while the editor is hidden"), so anything looser
// matches two buttons.
const toggle = (name: string) => screen.getByRole("button", { name });

const SIDEBAR = "Show or hide the sidebar (⌘B)";
const TERMINAL = "Show or hide the terminal (⌘⌥J)";
const EDITOR = "Show or hide the editor (⌘⌥E)";
const TERMINAL_BLOCKED = "Can't hide the terminal while the editor is hidden";

describe("LayoutToggles", () => {
  it("reflects each pane's visibility as the button's pressed state", () => {
    // The sidebar is the pane with no invariant on it, so it is the one that can
    // be hidden without renaming the pair's buttons.
    render(() => (
      <LayoutToggles showSidebar={false} showTerminal showEditor />
    ));

    expect(toggle(SIDEBAR).getAttribute("aria-pressed")).toBe("false");
    expect(toggle(TERMINAL).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(EDITOR).getAttribute("aria-pressed")).toBe("true");

    // The hidden-pane accent hangs off this attribute now, so its absence is
    // load-bearing rather than cosmetic.
    expect(toggle(SIDEBAR).hasAttribute("data-pressed")).toBe(false);
    expect(toggle(TERMINAL).hasAttribute("data-pressed")).toBe(true);
  });

  it("emits the toggled pane's event, and only that one", () => {
    const sidebar = listen(TOGGLE_SIDEBAR);
    const terminal = listen(TOGGLE_TERMINAL);
    const editor = listen(TOGGLE_EDITOR);
    render(() => <LayoutToggles {...ALL_SHOWN} />);

    fireEvent.click(toggle(TERMINAL));

    expect(terminal).toHaveBeenCalledTimes(1);
    expect(sidebar).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
  });

  it("emits when a hidden pane is brought back", () => {
    const sidebar = listen(TOGGLE_SIDEBAR);
    render(() => (
      <LayoutToggles showSidebar={false} showTerminal showEditor />
    ));

    fireEvent.click(toggle(SIDEBAR));

    expect(sidebar).toHaveBeenCalledTimes(1);
  });

  it("disables the last visible pane of the terminal/editor pair", () => {
    const terminal = listen(TOGGLE_TERMINAL);
    render(() => (
      <LayoutToggles showSidebar showTerminal showEditor={false} />
    ));

    expect((toggle(TERMINAL_BLOCKED) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle(TERMINAL_BLOCKED));
    expect(terminal).not.toHaveBeenCalled();

    // The editor is hidden, so bringing it back is still allowed.
    expect((toggle(EDITOR) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a disabled pane's tooltip reachable", () => {
    // A disabled button fires no pointer events, so `Tooltip` wraps it in a
    // hover surface when asked. That wrapping has to survive being rendered
    // through the toggle item; without it the "can't hide the terminal" reason
    // is unreachable at exactly the moment it needs explaining.
    render(() => (
      <LayoutToggles showSidebar showTerminal showEditor={false} />
    ));

    const surface = toggle(TERMINAL_BLOCKED).closest("[data-tooltip-hover-surface]");
    expect(surface).not.toBeNull();
  });

  it("keeps its buttons, and the focus on them, when a pane flips", () => {
    // The state comes back through props, so every toggle re-renders this
    // component. Building the item list from props inside a `<For>` gives Solid
    // three new identities each time: the buttons are torn down and rebuilt, and
    // a keyboard user pressing Space watches focus fall to the body. Static
    // tests cannot see it - the props have to actually change.
    const [sidebar, setSidebar] = createSignal(true);
    render(() => (
      <LayoutToggles showSidebar={sidebar()} showTerminal showEditor />
    ));

    const before = toggle(TERMINAL);
    before.focus();
    setSidebar(false);

    expect(toggle(TERMINAL)).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(toggle(SIDEBAR).hasAttribute("data-pressed")).toBe(false);
  });

  it("roves focus across the cluster with arrow keys", () => {
    render(() => <LayoutToggles {...ALL_SHOWN} />);

    toggle(SIDEBAR).focus();
    fireEvent.keyDown(toggle(SIDEBAR), { key: "ArrowRight" });
    expect(document.activeElement).toBe(toggle(TERMINAL));

    fireEvent.keyDown(toggle(TERMINAL), { key: "End" });
    expect(document.activeElement).toBe(toggle(EDITOR));
  });

  it("has no violations", async () => {
    const { container } = render(() => <LayoutToggles {...ALL_SHOWN} />);
    await expectNoAxeViolations(container);
  });
});
