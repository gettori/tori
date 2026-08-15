import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import OverflowTabBar from "./OverflowTabBar";
import { pointerClick } from "../test/menus";
import Tab from "./Tab/Tab";

// The `+N` button, which issue 102 turned from a raw button carrying a native
// title into a `Tooltip as="button"`. (Spelled out rather than written as an
// attribute: `interactiveTitle.test.ts` counts prose too, by design.) That
// matters more than the tooltip itself. It used to be about a `ref`: `openMenu`
// read the button's rect for an anchor and bailed without it, so a ref swallowed
// by the polymorphic trigger left a control that looked right and did nothing.
// The rect is gone (#103 phase 4 put the menu on a real trigger), and the same
// failure is now one layer out: the button belongs to its `Tooltip`, so the menu
// wraps it, and a wrapper that swallowed the button would fail the same way.
//
// jsdom reports every width as 0, so `computeVisibleCount` keeps nothing and
// every tab overflows. That is what puts the `+N` button on screen here without
// having to fake a layout.
// jsdom has no ResizeObserver, and the bar installs one on mount. The same stub
// the Editor suites use, since measurement is not what is under test here.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

type Item = { id: string; name: string };
const ITEMS: Item[] = [
  { id: "a", name: "alpha" },
  { id: "b", name: "beta" },
  { id: "c", name: "gamma" },
];

function mount(onActivate: (id: string) => void = () => {}) {
  return render(() => (
    <OverflowTabBar
      items={ITEMS}
      activeId={null}
      idOf={(t) => t.id}
      onActivate={onActivate}
      onReorder={() => {}}
      renderTab={(t) => <Tab>{t.name}</Tab>}
      renderMenuItem={(t) => <span>{t.name}</span>}
    />
  ));
}

describe("the overflow button", () => {
  it("opens its menu, so the trigger ref survived the tooltip", async () => {
    const picked: string[] = [];
    mount((id) => picked.push(id));

    const more = await screen.findByRole("button", { name: /more$/ });
    pointerClick(more);

    // The button belongs to its `Tooltip`, so the menu wraps it rather than
    // being it, and what this asserts is that the right-click still reaches the
    // wrapper: a trigger that swallowed the button would leave a control that
    // looks right and does nothing. Same shape as the ref this used to guard.
    const menu = await waitFor(() => screen.getByRole("menu"));
    pointerClick(screen.getAllByText("beta").find((el) => menu.contains(el))!);

    expect(picked).toEqual(["b"]);
  });

  it("names itself, which a title never did", async () => {
    mount();

    // It used to be a `title` on a raw button: hover text, and no accessible
    // name at all for a control whose only content is a "+N" glyph. How many
    // overflow depends on a measurement pass, so the count is read off the
    // control rather than written twice.
    const more = await screen.findByRole("button", { name: /^\d+ more$/ });
    const name = more.getAttribute("aria-label");

    more.focus();
    fireEvent.focus(more);

    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe(name));
  });
});
