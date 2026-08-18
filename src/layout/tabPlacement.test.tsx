// Tab placement (plan phase 8): the pane a tab is in, the guard that refuses a
// move, and the close-pane merge. Pure model, so this runs without a DOM.
import { describe, it, expect, beforeEach } from "vitest";
import {
  activeIdInPane,
  forgetTab,
  homePane,
  mergePaneInto,
  moveTabToPane,
  orderInPane,
  paneOfTab,
  placementRefusal,
  resetTabPlacement,
  setPaneActive,
  stampOrder,
  type TabRef,
} from "./tabPlacement";
import { seedTwoPane } from "./layoutStore";
import { splitPane, type PaneLeaf, type PaneNode } from "./paneLayout";

const WS = "/space/proj/main";
const leaf = (id: string): PaneLeaf => ({ type: "pane", id, size: 50, hidden: false });
const twoPane = () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true }).layout;
const threePane = () => splitPane(twoPane(), "left", "row", leaf("pane-1"))!;

const sh = (id: string): TabRef => ({ id, kind: "shell" });
const file = (id: string): TabRef => ({ id, kind: "file" });

beforeEach(() => {
  localStorage.clear();
  resetTabPlacement();
});

describe("where a tab is", () => {
  it("follows the pin rule until something moves it", () => {
    const root = twoPane();
    expect(paneOfTab(WS, sh("sh:1"), root)).toBe("left");
    expect(paneOfTab(WS, file("/a.ts"), root)).toBe("right");
  });

  it("keeps a moved tab where it was put, and its kind where it was", () => {
    const root = threePane();
    expect(moveTabToPane({ ws: WS, tab: sh("sh:1"), targetPaneId: "pane-1", root, tabsInWs: [sh("sh:1")] })).toBeNull();
    expect(paneOfTab(WS, sh("sh:1"), root)).toBe("pane-1");
    // Only that tab: the next shell still opens where shells open.
    expect(paneOfTab(WS, sh("sh:2"), root)).toBe("left");
    expect(homePane(WS, "shell", root)).toBe("left");
  });

  it("takes the file kind's home along, so the next file opens beside it", () => {
    const root = threePane();
    const tabs = [file("/a.ts")];
    expect(moveTabToPane({ ws: WS, tab: tabs[0], targetPaneId: "pane-1", root, tabsInWs: tabs })).toBeNull();
    expect(paneOfTab(WS, file("/c.ts"), root)).toBe("pane-1");
  });

  it("falls back to the pin rule when the stored pane is gone", () => {
    const root = threePane();
    moveTabToPane({ ws: WS, tab: sh("sh:1"), targetPaneId: "pane-1", root, tabsInWs: [sh("sh:1")] });
    expect(paneOfTab(WS, sh("sh:1"), twoPane())).toBe("left");
  });
});

describe("the interim single-pane guard", () => {
  it("refuses a file tab that would strand its siblings, and says why", () => {
    const root = threePane();
    const tabs = [file("/a.ts"), file("/b.ts")];
    const why = placementRefusal({ ws: WS, tab: tabs[0], targetPaneId: "pane-1", root, tabsInWs: tabs });
    expect(why).toMatch(/one pane for now/);
    expect(why).toContain("1 file tab");
    // Refused means unmoved, through the move path too.
    expect(moveTabToPane({ ws: WS, tab: tabs[0], targetPaneId: "pane-1", root, tabsInWs: tabs })).toBe(why);
    expect(paneOfTab(WS, tabs[0], root)).toBe("right");
  });

  it("allows the lone file tab, and every terminal tab", () => {
    const root = threePane();
    expect(
      placementRefusal({ ws: WS, tab: file("/a.ts"), targetPaneId: "pane-1", root, tabsInWs: [file("/a.ts")] }),
    ).toBeNull();
    expect(
      placementRefusal({
        ws: WS,
        tab: sh("sh:1"),
        targetPaneId: "pane-1",
        root,
        tabsInWs: [sh("sh:1"), sh("sh:2")],
      }),
    ).toBeNull();
  });

  it("refuses a pane that is not in the tree", () => {
    expect(
      placementRefusal({ ws: WS, tab: sh("sh:1"), targetPaneId: "nope", root: twoPane(), tabsInWs: [sh("sh:1")] }),
    ).toBe("That pane is gone.");
  });
});

describe("closing a pane", () => {
  const root: PaneNode = threePane();
  const tabs = [sh("sh:1"), sh("sh:2"), sh("sh:3")];

  it("hands every tab to the neighbour, appended after what it held", () => {
    moveTabToPane({ ws: WS, tab: tabs[2], targetPaneId: "pane-1", root, tabsInWs: tabs });
    mergePaneInto({ ws: WS, from: "pane-1", to: "left", root, tabsInWs: tabs });
    expect(tabs.every((t) => paneOfTab(WS, t, root) === "left")).toBe(true);
    // sh:3 came from the closed pane, so it lands behind the two already there.
    expect(orderInPane(WS, tabs).map((t) => t.id)).toEqual(["sh:1", "sh:2", "sh:3"]);
  });

  it("takes the kind home with it, so new tabs do not open into a closed pane", () => {
    moveTabToPane({ ws: WS, tab: file("/a.ts"), targetPaneId: "pane-1", root, tabsInWs: [file("/a.ts")] });
    mergePaneInto({ ws: WS, from: "pane-1", to: "right", root, tabsInWs: [file("/a.ts")] });
    expect(homePane(WS, "file", root)).toBe("right");
  });
});

describe("which tab a pane shows", () => {
  it("lets the kind's own active tab decide, and breaks a tie with the pane's pick", () => {
    expect(activeIdInPane(WS, "left", ["a", "b"], ["b"])).toBe("b");
    setPaneActive(WS, "left", "a");
    expect(activeIdInPane(WS, "left", ["a", "b"], ["a", "b"])).toBe("a");
    // Nothing claimed and nothing stored that is still here: the first tab.
    expect(activeIdInPane(WS, "right", ["x", "y"], [])).toBe("x");
  });

  it("forgets a closed tab, so a reopened path does not inherit its pane", () => {
    const root = threePane();
    moveTabToPane({ ws: WS, tab: sh("sh:1"), targetPaneId: "pane-1", root, tabsInWs: [sh("sh:1")] });
    forgetTab(WS, "sh:1");
    expect(paneOfTab(WS, sh("sh:1"), root)).toBe("left");
  });
});

describe("order inside a pane", () => {
  it("keeps store order until a stamp says otherwise", () => {
    const tabs = [sh("a"), sh("b"), sh("c")];
    expect(orderInPane(WS, tabs).map((t) => t.id)).toEqual(["a", "b", "c"]);
    stampOrder(WS, ["c", "a", "b"]);
    expect(orderInPane(WS, tabs).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });
});
