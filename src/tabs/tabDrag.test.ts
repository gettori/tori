// The two pure halves of a tab drag (plan phase 10 tasks 1, 2 and 5): the
// geometry that reads a pointer over a pane, and the rule that turns a zone
// into an edit. Both are decided here rather than in the DOM, so the guards can
// be stated as "this drop is nothing" without standing a layout up first.
import { describe, it, expect } from "vite-plus/test";
import { dropAction, hitTest, type DragTab, type Rect } from "./tabDrag";

const pane: Rect = { left: 0, top: 0, width: 400, height: 300 };
const strip: Rect = { left: 0, top: 0, width: 400, height: 40 };
// Three tabs, 100 wide, in the strip: midpoints at 50, 150 and 250.
const tabs = [
  { id: "a", rect: { left: 0, top: 0, width: 100, height: 40 } },
  { id: "b", rect: { left: 100, top: 0, width: 100, height: 40 } },
  { id: "c", rect: { left: 200, top: 0, width: 100, height: 40 } },
];
const at = (x: number, y: number) => hitTest({ x, y, pane, strip, tabs });

const drag = (over: Partial<DragTab> = {}): DragTab => ({
  id: "b",
  kind: "shell",
  ws: "/ws",
  fromPane: "left",
  ...over,
});

describe("where a pointer over a pane is aiming", () => {
  it("reads the strip as a place between two tabs", () => {
    expect(at(10, 20)).toEqual({ kind: "strip", afterId: null });
    expect(at(120, 20)).toEqual({ kind: "strip", afterId: "a" });
    expect(at(260, 20)).toEqual({ kind: "strip", afterId: "c" });
  });

  it("gives the strip the pointer even where an edge band would reach", () => {
    // x=5 is inside the left band; the strip is above it in the precedence.
    expect(at(5, 20)).toEqual({ kind: "strip", afterId: null });
  });

  it("claims the four edges of the stage, horizontal first at a corner", () => {
    expect(at(10, 150)).toEqual({ kind: "edge", dir: "left" });
    expect(at(390, 150)).toEqual({ kind: "edge", dir: "right" });
    expect(at(200, 60)).toEqual({ kind: "edge", dir: "top" });
    expect(at(200, 290)).toEqual({ kind: "edge", dir: "bottom" });
    expect(at(5, 290)).toEqual({ kind: "edge", dir: "left" });
  });

  it("leaves the middle as the center, and answers nothing outside the pane", () => {
    expect(at(200, 150)).toEqual({ kind: "center" });
    expect(at(500, 150)).toBeNull();
  });
});

describe("what a drop in that zone does", () => {
  it("moves a tab from another pane to the slot it was dropped in", () => {
    const a = dropAction({
      zone: { kind: "strip", afterId: "x" },
      drag: drag({ id: "sh:9", fromPane: "left" }),
      paneId: "right",
      idsInPane: ["x", "y"],
      countInFrom: 2,
    });
    expect(a).toEqual({ type: "move", paneId: "right", index: 1 });
  });

  it("appends on a center drop", () => {
    const a = dropAction({
      zone: { kind: "center" },
      drag: drag({ id: "sh:9" }),
      paneId: "right",
      idsInPane: ["x", "y"],
      countInFrom: 2,
    });
    expect(a).toEqual({ type: "move", paneId: "right", index: 2 });
  });

  it("splits the pane it was dropped on, on the side it was dropped", () => {
    const cases = [
      ["left", "row", "before"],
      ["right", "row", "after"],
      ["top", "column", "before"],
      ["bottom", "column", "after"],
    ] as const;
    for (const [dir, splitDir, pos] of cases) {
      expect(
        dropAction({
          zone: { kind: "edge", dir },
          drag: drag(),
          paneId: "right",
          idsInPane: ["x"],
          countInFrom: 2,
        }),
      ).toEqual({ type: "split", paneId: "right", dir: splitDir, pos });
    }
  });

  it("keeps an overflowed tab out of the arithmetic", () => {
    // Four tabs open, two of them fitting: a drop past the last visible one
    // lands after it, not at the end of a list it cannot see.
    const a = dropAction({
      zone: { kind: "strip", afterId: "b" },
      drag: drag({ id: "z", fromPane: "right" }),
      paneId: "left",
      idsInPane: ["a", "b", "c", "d"],
      countInFrom: 1,
    });
    expect(a).toEqual({ type: "move", paneId: "left", index: 2 });
  });
});

describe("the drops that mean nothing", () => {
  const own = { drag: drag(), paneId: "left", idsInPane: ["a", "b", "c"], countInFrom: 3 };

  it("refuses the slot the tab is already in, from either side of it", () => {
    expect(dropAction({ ...own, zone: { kind: "strip", afterId: "a" } })).toBeNull();
    expect(dropAction({ ...own, zone: { kind: "strip", afterId: "b" } })).toBeNull();
  });

  it("refuses a center drop by the tab that is already last", () => {
    expect(
      dropAction({ ...own, zone: { kind: "center" }, drag: drag({ id: "c" }) }),
    ).toBeNull();
  });

  it("still reorders inside its own strip when the slot really differs", () => {
    expect(dropAction({ ...own, zone: { kind: "strip", afterId: "c" } })).toEqual({
      type: "move",
      paneId: "left",
      index: 2,
    });
    expect(dropAction({ ...own, zone: { kind: "strip", afterId: null } })).toEqual({
      type: "move",
      paneId: "left",
      index: 0,
    });
  });

  it("refuses its own pane's edge while it is the only tab there", () => {
    // The split would make a pane for it and empty the one it left, which
    // collapses again: the same layout, twice the churn.
    expect(
      dropAction({
        zone: { kind: "edge", dir: "right" },
        drag: drag({ id: "a" }),
        paneId: "left",
        idsInPane: ["a"],
        countInFrom: 1,
      }),
    ).toBeNull();
    // With a sibling left behind it is a real split.
    expect(
      dropAction({
        zone: { kind: "edge", dir: "right" },
        drag: drag({ id: "a" }),
        paneId: "left",
        idsInPane: ["a", "b"],
        countInFrom: 2,
      }),
    ).toEqual({ type: "split", paneId: "left", dir: "row", pos: "after" });
  });
});
