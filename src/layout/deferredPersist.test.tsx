// The layout stores write on a debounce (plan phase 4 task 1): a click changes
// the model now and pays for the JSON later. What the suite is about is the
// safety half, since a deferred write that never lands is data loss.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ensureEnvelope,
  flushEnvelopes,
  resetPaneLayoutModel,
  seedTwoPane,
  setFocusedPane,
} from "./layoutStore";
import { flushTabPlacement, resetTabPlacement, setPaneActive } from "./tabPlacement";

const WS = "/w/a";
const seed = () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true });

const stored = (key: string) => localStorage.getItem(key);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetPaneLayoutModel();
  resetTabPlacement();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a store write during a click", () => {
  it("writes nothing to localStorage in the frame itself", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    ensureEnvelope(WS, seed);
    setFocusedPane(WS, "right");
    setPaneActive(WS, "left", "sh:1");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("coalesces a burst of clicks into one write per store", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    ensureEnvelope(WS, seed);
    for (let i = 0; i < 20; i++) {
      setFocusedPane(WS, i % 2 ? "left" : "right");
      setPaneActive(WS, "left", `sh:${i}`);
    }
    vi.runAllTimers();
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(["sway.panes.v1", "sway.tabpanes.v1"]);
    spy.mockRestore();
  });

  it("lands on its own once the burst stops", () => {
    ensureEnvelope(WS, seed);
    setPaneActive(WS, "left", "sh:1");
    expect(stored("sway.tabpanes.v1")).toBeNull();
    vi.runAllTimers();
    expect(JSON.parse(stored("sway.tabpanes.v1")!)[WS].active).toEqual({ left: "sh:1" });
  });
});

describe("the flush hooks", () => {
  it("lands a pending write when the window goes away", () => {
    ensureEnvelope(WS, seed);
    setFocusedPane(WS, "right");
    setPaneActive(WS, "left", "sh:1");
    dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(stored("sway.panes.v1")!)[WS].focusedPaneId).toBe("right");
    expect(JSON.parse(stored("sway.tabpanes.v1")!)[WS].active).toEqual({ left: "sh:1" });
  });

  it("is a no-op with nothing pending", () => {
    flushEnvelopes();
    flushTabPlacement();
    expect(stored("sway.panes.v1")).toBeNull();
    expect(stored("sway.tabpanes.v1")).toBeNull();
  });

  // A reset reloads from storage, so a write still holding the state it is
  // about to discard would land on top of what was just loaded.
  it("drops a pending write when the model resets", () => {
    ensureEnvelope(WS, seed);
    setFocusedPane(WS, "right");
    resetPaneLayoutModel();
    vi.runAllTimers();
    expect(stored("sway.panes.v1")).toBeNull();
  });
});
