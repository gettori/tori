import { describe, it, expect } from "vite-plus/test";
import { computeVisibleCount, moveIntoView, type Reserves } from "./tabOverflow";

const R = (over: Partial<Reserves> = {}): Reserves => ({
  padding: 0,
  trailing: 0,
  count: 0,
  safety: 0,
  ...over,
});

describe("computeVisibleCount", () => {
  it("returns 0 for no tabs", () => {
    expect(computeVisibleCount([], 500, R())).toBe(0);
  });

  it("shows all tabs when they fit, without reserving the count button", () => {
    // extents 100,200,300; bar 300; if it tried to reserve count(50) one would drop.
    expect(computeVisibleCount([100, 200, 300], 300, R({ count: 50 }))).toBe(3);
  });

  it("reserves the count button once overflow exists", () => {
    // 4 tabs at 100 each, bar 350: without count, 3 fit (<=350); but overflow
    // exists (4th=400>350), so reserve count(60) -> usable 290 -> 2 fit.
    expect(computeVisibleCount([100, 200, 300, 400], 350, R({ count: 60 }))).toBe(2);
  });

  it("accounts for padding, trailing, and safety reserves", () => {
    // bar 300, padding 8, trailing 50, safety 4 -> usable 238; extents 100,200,300.
    // 300>238 so overflow; usable2 = 238 - count(40) = 198 -> only the 100 tab fits.
    expect(computeVisibleCount([100, 200, 300], 300, R({ padding: 8, trailing: 50, count: 40, safety: 4 }))).toBe(1);
  });

  it("never returns less than 1 when tabs exist, even if none fit", () => {
    expect(computeVisibleCount([500], 100, R())).toBe(1);
    expect(computeVisibleCount([500, 600], 100, R({ count: 40 }))).toBe(1);
  });

  // The History button widened the pinned trailing cluster. The bar must answer
  // that by showing fewer tabs and collapsing the rest into `+N` - the one thing
  // it must never do is scroll, which is what makes the reserve load-bearing
  // rather than cosmetic.
  it("gives back tabs when the trailing cluster grows, rather than overflowing the bar", () => {
    const extents = [100, 200, 300, 400];
    const before = computeVisibleCount(extents, 500, R({ trailing: 60, count: 40 }));
    const after = computeVisibleCount(extents, 500, R({ trailing: 110, count: 40 }));
    expect(before).toBe(4); // everything fits beside the narrower cluster
    expect(after).toBeLessThan(before); // the wider one costs a tab
    // And what it costs still fits: the last visible tab's right edge is inside
    // what the bar has left after the cluster and the `+N` button.
    expect(extents[after - 1]).toBeLessThanOrEqual(500 - 110 - 40);
  });

  it("off-by-one: a tab exactly on the edge counts as fitting", () => {
    expect(computeVisibleCount([100, 200], 200, R())).toBe(2); // 200 <= 200
    expect(computeVisibleCount([100, 201], 200, R({ count: 0 }))).toBe(1); // 201 > 200, overflow
  });
});

describe("moveIntoView", () => {
  const idOf = (t: { id: string }) => t.id;
  const mk = (ids: string[]) => ids.map((id) => ({ id }));

  it("moves an overflow tab into the last visible slot, displaced tab leads overflow", () => {
    const items = mk(["1", "2", "3", "4", "5", "6", "7", "8"]);
    const next = moveIntoView(items, "7", 4, idOf); // visibleCount-1 = 4
    expect(next.map(idOf)).toEqual(["1", "2", "3", "4", "7", "5", "6", "8"]);
  });

  it("preserves element identity (same object references)", () => {
    const items = mk(["1", "2", "3"]);
    const next = moveIntoView(items, "3", 0, idOf);
    expect(next).not.toBe(items); // new array (so a signal reacts)
    expect(next[0]).toBe(items[2]); // but the moved element is the SAME object
    expect(next[1]).toBe(items[0]);
  });

  it("is a no-op (same array ref) when the id is missing", () => {
    const items = mk(["1", "2"]);
    expect(moveIntoView(items, "x", 0, idOf)).toBe(items);
  });

  it("is a no-op (same array ref) when already at the target slot", () => {
    const items = mk(["1", "2", "3"]);
    expect(moveIntoView(items, "2", 1, idOf)).toBe(items);
  });

  it("clamps an out-of-range target index", () => {
    const items = mk(["1", "2", "3"]);
    expect(moveIntoView(items, "1", 99, idOf).map(idOf)).toEqual(["2", "3", "1"]);
  });
});
