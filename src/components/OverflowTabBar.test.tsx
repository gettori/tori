import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import OverflowTabBar from "./OverflowTabBar";
import Tab from "./Tab/Tab";

// The `+N` button, which issue 102 turned from a raw button carrying a native
// title into a `Tooltip as="button"`. (Spelled out rather than written as an
// attribute: `interactiveTitle.test.ts` counts prose too, by design.) That matters more than the tooltip itself: the button
// holds a `ref` that `openMenu()` reads for its anchor and returns early
// without, so a ref swallowed by the polymorphic trigger would leave the
// overflow menu silently unopenable - a control that looks right and does
// nothing. The same shape as `Picker`'s trigger ref, which the model/mode
// picker suites happen to cover; nothing covered this one.
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
    fireEvent.click(more);

    // `openMenu` reads `countBtn.getBoundingClientRect()` for the anchor and
    // bails if the ref is unset, so the menu existing at all is the assertion.
    const menu = await waitFor(() => screen.getByRole("menu"));
    fireEvent.click(screen.getAllByText("beta").find((el) => menu.contains(el))!);

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
