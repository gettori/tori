import { describe, it, expect, beforeEach } from "vitest";
import {
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
  MAX_PANES,
  closePane,
  findPane,
  leaves,
  mapNode,
  movePane,
  nextActiveAfterClose,
  resetPaneLayoutIds,
  resizePane,
  resolvePinPane,
  resolveTogglePane,
  setPaneHidden,
  splitPane,
  visibleLeaves,
} from "./paneLayout";

// The pane layout tree, pinned before any UI renders from it (plan phase 5).
// Everything here is a pure edit on plain data: the interesting properties are
// that no operation can leave the tree denormalized (sizes off 100, empty or
// single-child splits) and that pane identity survives every edit, because a
// pane's id is what keeps its DOM, and the PTY inside it, alive.

const leaf = (id: string, size = 50, hidden = false): PaneLeaf => ({
  type: "pane",
  id,
  size,
  hidden,
});

/** Today's default: two panes in a row. */
const twoPane = (): PaneNode => ({
  type: "split",
  id: "root",
  dir: "row",
  size: 100,
  children: [leaf("left"), leaf("right")],
});

const sizes = (root: PaneNode) => leaves(root).map((l) => [l.id, Math.round(l.size)]);

beforeEach(() => resetPaneLayoutIds());

describe("splitPane", () => {
  it("splitting along the parent direction inserts a sibling, halving the target's share", () => {
    const next = splitPane(twoPane(), "left", "row", leaf("c"))!;
    expect(sizes(next)).toEqual([
      ["left", 25],
      ["c", 25],
      ["right", 50],
    ]);
    // No new split node appeared: same-direction geometry stays one flat row.
    expect((next as PaneSplit).children.every((c) => c.type === "pane")).toBe(true);
  });

  it("splitting across the parent direction nests a new split in the target's slot", () => {
    const next = splitPane(twoPane(), "left", "column", leaf("c"))!;
    const nested = (next as PaneSplit).children[0] as PaneSplit;
    expect(nested.type).toBe("split");
    expect(nested.dir).toBe("column");
    expect(nested.size).toBe(50);
    expect(sizes(nested)).toEqual([
      ["left", 50],
      ["c", 50],
    ]);
  });

  it("splitting a root leaf creates the root split", () => {
    const next = splitPane(leaf("only", 100), "only", "row", leaf("b"))!;
    expect(next.type).toBe("split");
    expect(sizes(next)).toEqual([
      ["only", 50],
      ["b", 50],
    ]);
  });

  it("puts the new pane on the side it was asked for, sibling or nested", () => {
    // What a drop on a pane's left or top edge asks for (plan phase 10).
    const flat = splitPane(twoPane(), "right", "row", leaf("c"), "before")!;
    expect(sizes(flat)).toEqual([
      ["left", 50],
      ["c", 25],
      ["right", 25],
    ]);
    const nested = splitPane(twoPane(), "left", "column", leaf("c"), "before")!;
    expect(sizes((nested as PaneSplit).children[0] as PaneSplit)).toEqual([
      ["c", 50],
      ["left", 50],
    ]);
  });

  it("refuses a split that would nest past the depth cap", () => {
    const nested = splitPane(twoPane(), "left", "column", leaf("c"))!;
    // "left" now sits under root > column split: a cross split there would be
    // depth 3.
    expect(splitPane(nested, "left", "row", leaf("d"))).toBeNull();
    // But along the column it is a sibling insert, which stays at depth 2.
    expect(splitPane(nested, "left", "column", leaf("d"))).not.toBeNull();
  });

  it("refuses a fifth pane", () => {
    let root = twoPane();
    root = splitPane(root, "left", "column", leaf("c"))!;
    root = splitPane(root, "right", "column", leaf("d"))!;
    expect(leaves(root).length).toBe(MAX_PANES);
    expect(splitPane(root, "c", "column", leaf("e"))).toBeNull();
  });

  it("refuses a duplicate pane id", () => {
    expect(splitPane(twoPane(), "left", "row", leaf("right"))).toBeNull();
  });
});

describe("closePane", () => {
  it("removes the pane and gives its share to the survivors, in proportion", () => {
    let root: PaneNode = {
      type: "split",
      id: "root",
      dir: "row",
      size: 100,
      children: [leaf("a", 60), leaf("b", 20), leaf("c", 20)],
    };
    root = closePane(root, "a")!;
    expect(sizes(root)).toEqual([
      ["b", 50],
      ["c", 50],
    ]);
  });

  it("collapses a split left with one child, the child inheriting the split's share", () => {
    const nested = splitPane(twoPane(), "left", "column", leaf("c"))!;
    const next = closePane(nested, "c")!;
    // The column split around left+c is gone; left is back in the root row at
    // the split's old 50 share.
    expect(sizes(next)).toEqual([
      ["left", 50],
      ["right", 50],
    ]);
    expect((next as PaneSplit).children.every((c) => c.type === "pane")).toBe(true);
  });

  it("refuses to remove the last pane", () => {
    expect(closePane(leaf("only", 100), "only")).toBeNull();
    const next = closePane(twoPane(), "left")!;
    expect(closePane(next, "right")).toBeNull();
  });
});

describe("movePane", () => {
  it("moves a pane beside the target, keeping its id", () => {
    let root = splitPane(twoPane(), "left", "column", leaf("c"))!;
    root = movePane(root, "c", "right", "after")!;
    expect(leaves(root).map((l) => l.id)).toEqual(["left", "right", "c"]);
    // The emptied column split collapsed away.
    expect((root as PaneSplit).children.every((c) => c.type === "pane")).toBe(true);
  });

  it("inserts before the target when asked", () => {
    const root = movePane(twoPane(), "right", "left", "before")!;
    expect(leaves(root).map((l) => l.id)).toEqual(["right", "left"]);
  });

  it("refuses a self move and unknown ids", () => {
    expect(movePane(twoPane(), "left", "left", "after")).toBeNull();
    expect(movePane(twoPane(), "ghost", "left", "after")).toBeNull();
    expect(movePane(twoPane(), "left", "ghost", "after")).toBeNull();
  });
});

describe("normalization through mapNode", () => {
  it("flattens a same-direction split into its parent", () => {
    // Hand-build the denormalized shape (an edit can produce it mid-pass when
    // a cross split collapses): a row inside a row.
    const root: PaneNode = {
      type: "split",
      id: "root",
      dir: "row",
      size: 100,
      children: [
        leaf("a", 50),
        { type: "split", id: "inner", dir: "row", size: 50, children: [leaf("b"), leaf("c")] },
      ],
    };
    // Any edit that rebuilds the root flattens it; delete "a".
    const next = mapNode(root, "a", () => null)!;
    expect((next as PaneSplit).children.every((c) => c.type === "pane")).toBe(true);
    expect(sizes(next)).toEqual([
      ["b", 50],
      ["c", 50],
    ]);
  });

  it("renormalizes sizes that no longer sum to 100", () => {
    const next = mapNode(twoPane(), "left", (n) => ({ ...(n as PaneLeaf), size: 25 }))!;
    expect(sizes(next)).toEqual([
      ["left", 33],
      ["right", 67],
    ]);
  });

  it("keeps object identity for untouched subtrees", () => {
    const root = splitPane(twoPane(), "left", "column", leaf("c"))! as PaneSplit;
    const rightBefore = root.children[1];
    const next = mapNode(root, "c", (n) => ({ ...(n as PaneLeaf), size: 70 }))! as PaneSplit;
    expect(next.children[1]).toBe(rightBefore);
  });

  it("keeps every pane id stable across split, move, and close", () => {
    let root: PaneNode = twoPane();
    root = splitPane(root, "left", "column", leaf("c"))!;
    root = movePane(root, "c", "right", "before")!;
    root = closePane(root, "left")!;
    expect(leaves(root).map((l) => l.id)).toEqual(["c", "right"]);
  });
});

describe("resizePane", () => {
  it("gives the pane its share and scales the siblings into the rest", () => {
    const root: PaneNode = {
      type: "split",
      id: "root",
      dir: "row",
      size: 100,
      children: [leaf("a", 50), leaf("b", 25), leaf("c", 25)],
    };
    const next = resizePane(root, "a", 60)!;
    expect(sizes(next)).toEqual([
      ["a", 60],
      ["b", 20],
      ["c", 20],
    ]);
  });

  it("clamps to keep every sibling drawable", () => {
    const next = resizePane(twoPane(), "left", 500)!;
    expect(sizes(next)).toEqual([
      ["left", 99],
      ["right", 1],
    ]);
  });

  it("returns a root leaf unchanged", () => {
    const only = leaf("only", 100);
    expect(resizePane(only, "only", 30)).toBe(only);
  });
});

describe("setPaneHidden", () => {
  it("hides and shows, keeping the pane's size for its return", () => {
    const hiddenTree = setPaneHidden(twoPane(), "right", true)!;
    expect(findPane(hiddenTree, "right")!.hidden).toBe(true);
    expect(findPane(hiddenTree, "right")!.size).toBe(50);
    const shown = setPaneHidden(hiddenTree, "right", false)!;
    expect(findPane(shown, "right")!.hidden).toBe(false);
    expect(findPane(shown, "right")!.size).toBe(50);
  });

  it("refuses to hide the last visible pane", () => {
    const oneHidden = setPaneHidden(twoPane(), "right", true)!;
    expect(visibleLeaves(oneHidden).map((l) => l.id)).toEqual(["left"]);
    expect(setPaneHidden(oneHidden, "left", true)).toBeNull();
  });
});

describe("resolvePinPane", () => {
  it("pins files right and every terminal kind left", () => {
    const root = twoPane();
    expect(resolvePinPane(root, "file")!.id).toBe("right");
    for (const kind of ["shell", "agent", "command", "chat", "task"]) {
      expect(resolvePinPane(root, kind)!.id).toBe("left");
    }
  });

  it("resolves spatially on whatever tree exists at call time", () => {
    const root = splitPane(twoPane(), "right", "row", leaf("far"))!;
    expect(resolvePinPane(root, "file")!.id).toBe("far");
  });
});

describe("resolveTogglePane", () => {
  it("zero matches falls back to the pin pane for the kind", () => {
    expect(resolveTogglePane(twoPane(), [], "file")).toBe("right");
    expect(resolveTogglePane(twoPane(), [], "chat")).toBe("left");
  });

  it("one match targets that tab's pane", () => {
    expect(resolveTogglePane(twoPane(), [{ paneId: "right", stamp: 1 }], "chat")).toBe("right");
  });

  it("two matches target the most recently focused one's pane", () => {
    const matches = [
      { paneId: "left", stamp: 3 },
      { paneId: "right", stamp: 7 },
    ];
    expect(resolveTogglePane(twoPane(), matches, "chat")).toBe("right");
  });

  it("ignores matches whose pane has since closed", () => {
    const matches = [
      { paneId: "gone", stamp: 9 },
      { paneId: "left", stamp: 1 },
    ];
    expect(resolveTogglePane(twoPane(), matches, "chat")).toBe("left");
  });
});

describe("nextActiveAfterClose", () => {
  it("prefers the right neighbor, then the left, then gives up", () => {
    expect(nextActiveAfterClose(["a", "b", "c"], "b")).toBe("c");
    expect(nextActiveAfterClose(["a", "b", "c"], "c")).toBe("b");
    expect(nextActiveAfterClose(["a"], "a")).toBeNull();
    expect(nextActiveAfterClose(["a", "b"], "ghost")).toBeNull();
  });
});
