// Where a kind opens (plan phase 11 task 1). The resolver is pure and answers
// against the tree it is handed, so the interesting cases are the trees a
// session actually produces: one after a split, one after a close, one with a
// pane hidden, and one where the user has locked a pane to a kind.
import { describe, it, expect, beforeEach } from "vitest";
import {
  closePane,
  leaves,
  resolvePinPane,
  splitPane,
  resetPaneLayoutIds,
  type PaneLeaf,
  type PaneNode,
} from "./paneLayout";
import { DEFAULT_PIN_SIDES, pinGroup, pinSideOf, resetPinRules, setPinSides } from "./pinRules";

const leaf = (id: string, size = 50, hidden = false): PaneLeaf => ({
  type: "pane",
  id,
  size,
  hidden,
});
const twoPane = (): PaneNode => ({
  type: "split",
  id: "root",
  dir: "row",
  size: 100,
  children: [leaf("left"), leaf("right")],
});
const at = (root: PaneNode, kind: string, rules?: Parameters<typeof resolvePinPane>[2]) =>
  resolvePinPane(root, kind, rules)?.id ?? null;

beforeEach(() => {
  resetPaneLayoutIds();
  resetPinRules();
});

describe("resolving a pin", () => {
  it("answers the end the rule names, whatever shape the tree is in", () => {
    const two = twoPane();
    expect(at(two, "file", { side: "rightmost" })).toBe("right");
    expect(at(two, "shell", { side: "leftmost" })).toBe("left");

    // After a split: the new pane is the end now, and the rule follows it
    // rather than the pane it used to name.
    const three = splitPane(two, "right", "row", leaf("pane-1"))!;
    expect(leaves(three).map((l) => l.id)).toEqual(["left", "right", "pane-1"]);
    expect(at(three, "file", { side: "rightmost" })).toBe("pane-1");

    // And after a close it falls back to whatever is at that end now.
    const closed = closePane(three, "pane-1")!;
    expect(at(closed, "file", { side: "rightmost" })).toBe("right");
  });

  it("still names a hidden pane, which is what a toggle reveals", () => {
    // The editor toggle hides the file pane. If a pin skipped hidden panes, the
    // next file would open in the terminal's pane and the toggle would reveal
    // an empty box.
    const hiddenRight: PaneNode = {
      type: "split",
      id: "root",
      dir: "row",
      size: 100,
      children: [leaf("left"), leaf("right", 50, true)],
    };
    expect(at(hiddenRight, "file", { side: "rightmost" })).toBe("right");
  });

  it("takes a lock over the side, and steps around one held by another kind", () => {
    const two = twoPane();
    // Locked to files: files open there even though the rule says the far end.
    expect(at(two, "file", { side: "rightmost", locks: { left: "file" } })).toBe("left");
    // Locked to something else: the rule resolves around it.
    expect(at(two, "file", { side: "rightmost", locks: { right: "shell" } })).toBe("left");
  });

  it("still places a tab when every pane is locked away from it", () => {
    // A tab has to go somewhere; the side's own end answers rather than the
    // resolver returning nothing and the tab having no pane at all.
    const two = twoPane();
    expect(at(two, "file", { side: "rightmost", locks: { left: "shell", right: "chat" } })).toBe(
      "right",
    );
  });

  it("keeps today's layout when it is asked with no rules at all", () => {
    const two = twoPane();
    expect(at(two, "file")).toBe("right");
    expect(at(two, "shell")).toBe("left");
    expect(at(two, "chat")).toBe("left");
  });

  it("answers nothing for a tree with no panes in it", () => {
    expect(resolvePinPane({ type: "split", id: "root", dir: "row", size: 100, children: [] }, "file")).toBeNull();
  });
});

describe("the rules the user sets", () => {
  it("maps every kind onto one of the three families", () => {
    expect(pinGroup("file")).toBe("file");
    expect(pinGroup("chat")).toBe("chat");
    for (const kind of ["shell", "agent", "command", "task"]) {
      expect(pinGroup(kind)).toBe("terminal");
    }
  });

  it("starts on today's layout and follows what is pushed in", () => {
    expect(pinSideOf("file")).toBe(DEFAULT_PIN_SIDES.file);
    expect(pinSideOf("shell")).toBe("leftmost");

    setPinSides({ file: "leftmost", terminal: "rightmost" });
    expect(pinSideOf("file")).toBe("leftmost");
    expect(pinSideOf("agent")).toBe("rightmost");
    // A partial answer leaves the rest on the default rather than unset.
    expect(pinSideOf("chat")).toBe("leftmost");
  });
});
