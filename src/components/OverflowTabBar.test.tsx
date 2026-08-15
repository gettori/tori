import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import OverflowTabBar from "./OverflowTabBar";
import { expectNoAxeViolations } from "../test/axe";
import { pointerClick } from "../test/menus";
import { setTabBarWidth } from "../test/tabLayout";
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
// The bar is 200px wide here, which fits one 120px tab once the `+N` button is
// reserved, so two overflow. It used to be that jsdom measured everything as 0
// and *everything* overflowed, which put the `+N` on screen by accident; the
// width is stated now, so what this file needs from the layout is readable.
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
  setTabBarWidth(200);
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

describe("what fits", () => {
  // Characterization, written before the Kobalte migration (skarif2/sway#111)
  // and expected to survive it unchanged: the widths at which the strip
  // collapses are the contract, not the markup underneath.
  const MANY: Item[] = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`,
    name: `tab ${i}`,
  }));

  function mountMany(width: number, onReorder: (next: Item[]) => void = () => {}) {
    setTabBarWidth(width);
    return render(() => (
      <OverflowTabBar
        items={MANY}
        activeId={null}
        idOf={(t) => t.id}
        onActivate={() => {}}
        onReorder={onReorder}
        renderTab={(t) => <Tab>{t.name}</Tab>}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));
  }

  it("draws the tabs that fit, and counts the rest", async () => {
    // 500px, less 6px of safety and the 40px `+N`, leaves room for three 120px
    // tabs. Reaching them needs no `hidden: true`: the visible row is the one
    // a browser draws, and now the one a test reads.
    mountMany(500);

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    expect(screen.getAllByRole("tab").map((el) => el.textContent)).toEqual([
      "tab 0",
      "tab 1",
      "tab 2",
    ]);
    expect(await screen.findByRole("button", { name: "9 more" })).toBeTruthy();
  });

  it("keeps every tab when the bar is wide enough", async () => {
    mountMany(2000);

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(12));
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("activates on the click, not on the press", async () => {
    // The editor's tabs are `draggable`, and a drag begins with a press that
    // never becomes a click: pressing a tab and dragging its path out to the
    // terminal must not load that file first. Kobalte's tab trigger selects on
    // pointerdown, so this is the contract #111 has to keep deliberately rather
    // than inherit.
    const picked: string[] = [];
    setTabBarWidth(2000);
    render(() => (
      <OverflowTabBar
        items={MANY}
        activeId={null}
        idOf={(t) => t.id}
        onActivate={(id) => picked.push(id)}
        onReorder={() => {}}
        renderTab={(t) => <Tab onClick={() => picked.push(t.id)}>{t.name}</Tab>}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));

    const target = await waitFor(() => screen.getByRole("tab", { name: "tab 4" }));
    fireEvent.mouseDown(target);
    fireEvent.pointerDown(target);
    expect(picked).toEqual([]);

    fireEvent.click(target);
    expect(picked).toEqual(["t4"]);
  });

  function mountActive(width: number, activeId: string | null) {
    setTabBarWidth(width);
    return render(() => (
      <OverflowTabBar
        items={MANY}
        activeId={activeId}
        idOf={(t) => t.id}
        onActivate={() => {}}
        onReorder={() => {}}
        renderTab={(t) => <Tab active={activeId === t.id}>{t.name}</Tab>}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));
  }

  it("always draws the active tab, however far down the list it is", async () => {
    // `displayOrder` pulls the active tab into the last visible slot for
    // rendering only, never reordering what the consumer holds. Kobalte is
    // about to depend on this harder than the strip does today: its tab root
    // force-selects the first key, and calls `onChange` doing it, whenever the
    // selected value is not among the tabs actually rendered. So a regression
    // here would not blank the selection, it would switch the user's file.
    mountActive(500, "t9");

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    const drawn = screen.getAllByRole("tab").map((el) => el.textContent);
    expect(drawn).toContain("tab 9");
    expect(drawn[drawn.length - 1]).toBe("tab 9");
  });

  it("selects nothing when nothing is active", async () => {
    mountActive(500, null);

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    expect(
      screen.getAllByRole("tab").filter((el) => el.getAttribute("aria-selected") === "true"),
    ).toHaveLength(0);
  });

  it("brings an overflowed tab into the row it was picked from", async () => {
    // The reorder is the bar's own: `moveIntoView` puts the pick in the last
    // visible slot and pushes the tab that was there into the overflow. The
    // canonical order the consumer holds is what changes, so the strip a
    // keyboard walks and the strip on screen stay the same list.
    const orders: string[][] = [];
    mountMany(500, (next) => orders.push(next.map((t) => t.id)));

    const more = await screen.findByRole("button", { name: "9 more" });
    pointerClick(more);
    const menu = await waitFor(() => screen.getByRole("menu"));
    pointerClick(screen.getAllByText("tab 7").find((el) => menu.contains(el))!);

    // Slot 2 is the last visible one at this width, so `tab 7` lands there and
    // `tab 2` is the one displaced.
    expect(orders[0].slice(0, 4)).toEqual(["t0", "t1", "t7", "t2"]);
  });
});

describe("the overflow button", () => {
  it("opens its menu, so the trigger ref survived the tooltip", async () => {
    const picked: string[] = [];
    mount((id) => picked.push(id));

    const more = await screen.findByRole("button", { name: /more$/ });
    pointerClick(more);

    // The button belongs to its `Tooltip`, so the menu wraps it rather than
    // being it, and what this asserts is that the click still reaches the
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

  it("still says it opens a menu, from the element a keyboard reaches", async () => {
    // The cost of the wrapper, and the one a scan can catch. Kobalte writes
    // `aria-haspopup` and `aria-expanded` on its trigger, which here is the
    // wrapper: not focusable, not what a screen reader lands on. The button
    // inside it is both, so it says this for itself, and this is the one open
    // menu at a wrapped site that the suite scans end to end.
    mount();
    const more = await screen.findByRole("button", { name: /more$/ });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");

    pointerClick(more);
    await waitFor(() => screen.getByRole("menu"));

    expect(more.getAttribute("aria-expanded")).toBe("true");
    // Two rows of rules off, for two different reasons.
    //
    // `aria-valid-attr-value` for the reason `Dropdown.test.tsx` records: axe
    // raises `controlsWithinPopup` for any trigger carrying both
    // `aria-haspopup` and `aria-controls`, in a real browser as much as here,
    // because it cannot tell whether the popup is open. Every Kobalte trigger
    // has both.
    //
    // The other two are this bar's own, they predate every menu here, and they
    // are real: its tabs carry `role="tab"` with no `role="tablist"` above
    // them, and its measuring ghost is `aria-hidden` while holding focusable
    // buttons. Neither is menu-shaped and neither is #103's to fix, so they are
    // named here rather than quietly swept into a passing scan.
    await expectNoAxeViolations(document.body, {
      rules: {
        "aria-valid-attr-value": { enabled: false },
        "aria-required-parent": { enabled: false },
        "aria-hidden-focus": { enabled: false },
      },
    });
  });
});
