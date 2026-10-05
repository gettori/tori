import { describe, it, expect } from "vite-plus/test";
import { createSignal, type JSX } from "solid-js";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import OverflowTabBar from "./OverflowTabBar";
import { expectNoAxeViolations } from "../test/axe";
import { pointerClick } from "../test/menus";
import { setTabBarWidth } from "../test/tabLayout";
import Tab from "./Tab/Tab";
import ContextMenu from "./Menu/ContextMenu";

/** The editor's tab wrapper, in miniature: `display: contents` around the tab,
 *  skipped for the ghost row. */
function MaybeMenu(p: { when: boolean; children: JSX.Element }) {
  if (!p.when) return p.children;
  return <ContextMenu items={[{ label: "Close", onClick: () => {} }]}>{p.children}</ContextMenu>;
}

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
      renderTab={(t) => <Tab value={t.id}>{t.name}</Tab>}
      renderMenuItem={(t) => <span>{t.name}</span>}
    />
  ));
}

describe("what fits", () => {
  // Characterization, written before the Kobalte migration (gettori/tori#111)
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
        renderTab={(t) => <Tab value={t.id}>{t.name}</Tab>}
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
    expect(screen.getAllByRole("tab").map((el) => el.textContent)).toEqual(["tab 0", "tab 1", "tab 2"]);
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
    // terminal must not load that file first.
    //
    // `pointerType: "mouse"` is the whole test. Kobalte's trigger selects on
    // press for a mouse and only for a mouse, and jsdom's default pointerdown
    // carries no pointer type at all - so the version of this without it passed
    // against a bar that selects on press in every real browser. The bar
    // swallows the press in the capture phase to keep this true; see the note
    // on `swallowPress`.
    const picked: string[] = [];
    setTabBarWidth(2000);
    render(() => (
      <OverflowTabBar
        items={MANY}
        activeId="t0"
        idOf={(t) => t.id}
        onActivate={(id) => picked.push(id)}
        onReorder={() => {}}
        renderTab={(t) => <Tab value={t.id}>{t.name}</Tab>}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));

    const target = await waitFor(() => screen.getByRole("tab", { name: "tab 4" }));
    fireEvent.mouseDown(target);
    fireEvent.pointerDown(target, { pointerType: "mouse", button: 0 });
    expect(picked).toEqual([]);

    fireEvent.click(target);
    expect(picked).toEqual(["t4"]);
  });

  it("counts every open tab, not the ones that fit", async () => {
    // The harm #114 names. Three of twelve are drawn at this width, and a strip
    // announcing "3 of 3" tells a reader the other nine do not exist. Kobalte
    // writes neither attribute, so the bar supplies both off the list the
    // consumer holds.
    mountMany(500);

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    const third = screen.getByRole("tab", { name: "tab 2" });
    expect(third.getAttribute("aria-posinset")).toBe("3");
    expect(third.getAttribute("aria-setsize")).toBe("12");
  });

  it("keeps the heal to itself when the active tab is closed under it", async () => {
    // Kobalte's tab root force-selects the first key whenever the value it
    // holds names no rendered tab, and calls `onChange` doing it. Closing the
    // active tab puts the strip in exactly that state for one render, before
    // the panel has picked what comes next - so an unguarded bar would not
    // blank the selection, it would open whatever file happens to be leftmost.
    const picked: string[] = [];
    const [items, setItems] = createSignal(MANY);
    setTabBarWidth(500);
    render(() => (
      <OverflowTabBar
        items={items()}
        activeId="t0"
        idOf={(t) => t.id}
        onActivate={(id) => picked.push(id)}
        onReorder={() => {}}
        renderTab={(t) => <Tab value={t.id}>{t.name}</Tab>}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));

    // The tab the strip is pointed at is gone, and `activeId` has not moved yet.
    setItems(MANY.filter((t) => t.id !== "t0"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "tab 1" })).toBeTruthy());

    expect(picked).toEqual([]);
  });

  it("keeps the heal to itself when a tab is closed by keystroke", async () => {
    // The close gesture that *does* land on a tab, and so the one the gate
    // cannot tell from a selection by target alone. A panel closes in two
    // writes (drop the tab, then move the id), Solid does not batch a delegated
    // handler, so the heal fires between them while this keystroke is still
    // dispatching. Without the close keys excluded at the mark, the bar reads
    // Kobalte's leftmost pick as the user's and opens the wrong tab.
    const picked: string[] = [];
    const [items, setItems] = createSignal(MANY);
    const [active, setActive] = createSignal<string | null>("t0");
    setTabBarWidth(2000);
    render(() => (
      <OverflowTabBar
        items={items()}
        activeId={active()}
        idOf={(t) => t.id}
        onActivate={(id) => {
          picked.push(id);
          setActive(id);
        }}
        onReorder={() => {}}
        renderTab={(t) => (
          <Tab
            value={t.id}
            onClose={() => {
              const remaining = items().filter((o) => o.id !== t.id);
              setItems(remaining);
              setActive(remaining[remaining.length - 1]?.id ?? null);
            }}
          >
            {t.name}
          </Tab>
        )}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));

    const target = await waitFor(() => screen.getByRole("tab", { name: "tab 0" }));
    target.focus();
    fireEvent.keyDown(target, { key: "Delete" });

    await waitFor(() => expect(screen.queryAllByRole("tab", { name: "tab 0" })).toHaveLength(0));
    expect(picked).toEqual([]);
    expect(active()).toBe("t11");
  });

  it("keeps arrow order matching visual order across a +N pick", async () => {
    // The only reorder this strip has. `moveIntoView` puts the pick in the last
    // visible slot and pushes the tab that was there into the overflow, so the
    // canonical list changes and the row redraws. What has to survive is that
    // the three lists agree: what is drawn, what an arrow walks, and what
    // `aria-posinset` announces.
    const [items, setItems] = createSignal(MANY);
    const [active, setActive] = createSignal<string | null>("t0");
    setTabBarWidth(500);
    render(() => (
      <OverflowTabBar
        items={items()}
        activeId={active()}
        idOf={(t) => t.id}
        onActivate={setActive}
        onReorder={setItems}
        renderTab={(t) => <Tab value={t.id}>{t.name}</Tab>}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));

    const more = await screen.findByRole("button", { name: "9 more" });
    pointerClick(more);
    const menu = await waitFor(() => screen.getByRole("menu"));
    pointerClick(screen.getAllByText("tab 7").find((el) => menu.contains(el))!);

    // Slot 2 is the last visible one at this width, so the pick lands there.
    await waitFor(() =>
      expect(screen.getAllByRole("tab").map((el) => el.textContent)).toEqual(["tab 0", "tab 1", "tab 7"]),
    );
    const picked = screen.getByRole("tab", { name: "tab 7" });
    expect(active()).toBe("t7");
    // Third on screen and third in the canonical list, which is what makes the
    // arrows and the announcement say the same thing.
    expect(picked.getAttribute("aria-posinset")).toBe("3");
    expect(picked.getAttribute("aria-setsize")).toBe("12");

    // ArrowLeft from the pick lands on the tab now drawn to its left, not on
    // whatever used to sit there.
    picked.focus();
    fireEvent.keyDown(picked, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "tab 1" })));
    expect(active()).toBe("t1");
  });

  it("still forwards a click when the strip has nothing active", async () => {
    // The heal guard keys off the gesture rather than off `activeId`, so a
    // strip that starts with no selection is still clickable. Gating on the
    // state instead would swallow this, and the two are indistinguishable from
    // the value alone: Kobalte's heal picks the leftmost tab, which is also
    // something a user can click.
    const picked: string[] = [];
    setTabBarWidth(2000);
    render(() => (
      <OverflowTabBar
        items={MANY}
        activeId={null}
        idOf={(t) => t.id}
        onActivate={(id) => picked.push(id)}
        onReorder={() => {}}
        renderTab={(t) => <Tab value={t.id}>{t.name}</Tab>}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));

    const target = await waitFor(() => screen.getByRole("tab", { name: "tab 0" }));
    fireEvent.click(target);
    expect(picked).toEqual(["t0"]);
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
        renderTab={(t) => <Tab value={t.id}>{t.name}</Tab>}
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
    expect(screen.getAllByRole("tab").filter((el) => el.getAttribute("aria-selected") === "true")).toHaveLength(0);
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

describe("the strip a panel actually renders", () => {
  it("is clean with a context menu between the tablist and the tab", async () => {
    // The editor wraps every tab in a `ContextMenu` for the right-click menu,
    // so the real tablist's children are menu triggers rather than tabs. A
    // tablist may own nothing but tabs and axe reads straight through a
    // role-less wrapper to what is underneath, so this is the shape that
    // decides whether the strip on screen is legal - and it is not the shape
    // the scans above cover.
    setTabBarWidth(2000);
    const { container } = render(() => (
      <OverflowTabBar
        items={ITEMS}
        activeId="a"
        idOf={(t) => t.id}
        onActivate={() => {}}
        onReorder={() => {}}
        renderTab={(t, ghost) => (
          <MaybeMenu when={!ghost}>
            <Tab value={t.id} onClose={() => {}}>
              {t.name}
            </Tab>
          </MaybeMenu>
        )}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    await expectNoAxeViolations(container, {
      rules: { "aria-valid-attr-value": { enabled: false } },
    });
  });

  it("is clean while overflowing, with a trailing action beside the tabs", async () => {
    // The other shape a panel renders, and what `OverflowTabBar.stories.tsx`
    // opens on: too narrow for its tabs, so the `+N` is up, with a pinned
    // action after it. Both sit outside the tablist, since a tablist may own
    // nothing but tabs, and this is what proves they are actually outside it
    // rather than merely drawn that way.
    setTabBarWidth(200);
    const { container } = render(() => (
      <OverflowTabBar
        items={ITEMS}
        activeId="a"
        idOf={(t) => t.id}
        onActivate={() => {}}
        onReorder={() => {}}
        trailing={<button type="button">New</button>}
        renderTab={(t) => (
          <Tab value={t.id} onClose={() => {}}>
            {t.name}
          </Tab>
        )}
        renderMenuItem={(t) => <span>{t.name}</span>}
      />
    ));

    await screen.findByRole("button", { name: /more$/ });
    await expectNoAxeViolations(container, {
      rules: { "aria-valid-attr-value": { enabled: false } },
    });
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
    // One rule off, for the reason `Dropdown.test.tsx` records: axe raises
    // `controlsWithinPopup` for any trigger carrying both `aria-haspopup` and
    // `aria-controls`, in a real browser as much as here, because it cannot
    // tell whether the popup is open. Every Kobalte trigger has both.
    //
    // `aria-required-parent` and `aria-hidden-focus` used to be named here too,
    // and were this bar's own: its tabs carried `role="tab"` with no tablist
    // above them, and its measuring ghost was `aria-hidden` around focusable
    // buttons. #111 fixed both rather than disabling them, so a scan that stops
    // being clean now fails.
    await expectNoAxeViolations(document.body, {
      rules: { "aria-valid-attr-value": { enabled: false } },
    });
  });
});
