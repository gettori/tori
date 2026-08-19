// The per-workspace layout envelope store (plan phase 5). A .tsx suite for the
// jsdom project: the store's whole job is localStorage round-trips, which the
// node project has no localStorage to run against.
import { describe, it, expect, beforeEach } from "vitest";
import {
  ensureEnvelope,
  envelopeFor,
  flushEnvelopes,
  focusedPaneId,
  persistEnvelopes,
  resetPaneLayoutModel,
  sanitizeEnvelope,
  seedTwoPane,
  setFocusedPane,
  updateLayout,
} from "./layoutStore";
import { findPane, setPaneHidden } from "./paneLayout";

const seed = () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true });

/** What the store wrote, reread the way a relaunch would: writes are deferred,
 *  so a quit flushes them and the next launch loads what landed. */
function relaunch() {
  flushEnvelopes();
  resetPaneLayoutModel();
}

beforeEach(() => {
  localStorage.clear();
  resetPaneLayoutModel();
});

describe("sanitizeEnvelope", () => {
  it("accepts what seedTwoPane writes", () => {
    expect(sanitizeEnvelope(seed())).not.toBeNull();
  });

  it("rejects a wrong version, a missing tree, and plain garbage", () => {
    expect(sanitizeEnvelope(null)).toBeNull();
    expect(sanitizeEnvelope("layout")).toBeNull();
    expect(sanitizeEnvelope({ version: 3, layout: seed().layout, focusedPaneId: "left" })).toBeNull();
    expect(sanitizeEnvelope({ version: 2, focusedPaneId: "left" })).toBeNull();
    // Version 1 is the two-pane default every workspace used to be seeded
    // with. Rejecting it *is* the migration (plan phase 12): the workspace
    // re-seeds as one pane and its tabs fall back to the pin rule.
    expect(sanitizeEnvelope({ version: 1, layout: seed().layout, focusedPaneId: "left" })).toBeNull();
  });

  it("rejects a tree holding an unknown node kind", () => {
    const env = {
      version: 2,
      layout: { type: "grid", id: "root", size: 100, children: [] },
      focusedPaneId: "root",
    };
    expect(sanitizeEnvelope(env)).toBeNull();
  });

  it("rejects splits nested past the depth cap", () => {
    const pane = (id: string) => ({ type: "pane", id, size: 50, hidden: false });
    const split = (id: string, children: unknown[]) => ({
      type: "split",
      id,
      dir: "row",
      size: 50,
      children,
    });
    const tooDeep = split("a", [split("b", [split("c", [pane("d"), pane("e")]), pane("f")]), pane("g")]);
    expect(sanitizeEnvelope({ version: 2, layout: tooDeep, focusedPaneId: "d" })).toBeNull();
  });

  it("rejects an all-hidden layout", () => {
    const hiddenPane = (id: string) => ({ type: "pane", id, size: 50, hidden: true });
    const both = {
      version: 2,
      layout: {
        type: "split",
        id: "root",
        dir: "row",
        size: 100,
        children: [hiddenPane("left"), hiddenPane("right")],
      },
      focusedPaneId: "left",
    };
    expect(sanitizeEnvelope(both)).toBeNull();
  });

  it("repairs a focusedPaneId that names no pane, instead of rejecting", () => {
    const env = { ...seed(), focusedPaneId: "gone" };
    expect(sanitizeEnvelope(env)!.focusedPaneId).toBe("left");
  });
});

describe("the envelope store", () => {
  it("falls back to the seed for a workspace with nothing stored", () => {
    expect(envelopeFor("/w/a", seed).focusedPaneId).toBe("left");
  });

  it("falls back to the seed when the stored envelope is malformed", () => {
    localStorage.setItem(
      "sway.panes.v1",
      JSON.stringify({ "/w/a": { version: 1, layout: { type: "grid" } } }),
    );
    relaunch();
    expect(envelopeFor("/w/a", seed).layout).toEqual(seed().layout);
  });

  it("keeps a hidden pane hidden across a relaunch", () => {
    ensureEnvelope("/w/a", seed);
    expect(updateLayout("/w/a", (root) => setPaneHidden(root, "right", true))).toBe(true);
    relaunch();
    expect(findPane(envelopeFor("/w/a", seed).layout, "right")!.hidden).toBe(true);
  });

  it("keeps each workspace's focused pane: A to B and back restores A's", () => {
    ensureEnvelope("/w/a", seed);
    ensureEnvelope("/w/b", seed);
    setFocusedPane("/w/a", "right");
    setFocusedPane("/w/b", "left");
    relaunch();
    expect(focusedPaneId("/w/a")).toBe("right");
    expect(focusedPaneId("/w/b")).toBe("left");
  });

  it("hands focus to a visible pane when the focused one hides", () => {
    ensureEnvelope("/w/a", seed);
    setFocusedPane("/w/a", "right");
    updateLayout("/w/a", (root) => setPaneHidden(root, "right", true));
    expect(focusedPaneId("/w/a")).toBe("left");
  });

  it("treats a refused edit as a no-op", () => {
    ensureEnvelope("/w/a", seed);
    updateLayout("/w/a", (root) => setPaneHidden(root, "right", true));
    // Hiding the last visible pane is refused by the tree layer; nothing moves.
    expect(updateLayout("/w/a", (root) => setPaneHidden(root, "left", true))).toBe(false);
    expect(findPane(envelopeFor("/w/a", seed).layout, "left")!.hidden).toBe(false);
    persistEnvelopes();
    relaunch();
    expect(findPane(envelopeFor("/w/a", seed).layout, "left")!.hidden).toBe(false);
  });
});
