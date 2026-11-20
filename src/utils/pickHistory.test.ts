import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import {
  loadPicks,
  MAX_QUERIES,
  parsePicks,
  PER_QUERY,
  picksFor,
  savePicks,
  withPick,
  type PickStore,
} from "./pickHistory";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("pickHistory", () => {
  it("remembers the picks for a query, newest first, by the whole query", () => {
    let store: PickStore = [];
    store = withPick(store, "side", "unit:a");
    store = withPick(store, "Side ", "unit:b");
    store = withPick(store, "side", "unit:a");
    expect(picksFor(store, "  SIDE")).toEqual(["unit:a", "unit:b"]);
    expect(picksFor(store, "sid")).toEqual([]);
    expect(withPick(store, "  ", "unit:c")).toBe(store);
  });

  it("caps the picks per query and the queries kept, dropping the oldest", () => {
    let store: PickStore = [];
    for (let i = 0; i <= PER_QUERY; i++) store = withPick(store, "side", `p${i}`);
    expect(picksFor(store, "side")).toHaveLength(PER_QUERY);
    expect(picksFor(store, "side")).not.toContain("p0");
    for (let i = 0; i < MAX_QUERIES; i++) store = withPick(store, `q${i}`, "x");
    expect(store).toHaveLength(MAX_QUERIES);
    expect(picksFor(store, "side")).toEqual([]);
  });

  it("keeps an all-digit query in its place and survives a reload", () => {
    savePicks(withPick(withPick([], "92", "unit:a"), "side", "unit:b"));
    expect(loadPicks().map(([q]) => q)).toEqual(["side", "92"]);
    expect(picksFor(loadPicks(), "92")).toEqual(["unit:a"]);
  });

  it("reads anything else in storage as nothing", () => {
    expect(parsePicks("{")).toEqual([]);
    expect(parsePicks('{"92":["a"]}')).toEqual([]);
    expect(parsePicks('[["side",["a"]],["bad",[1]],"x"]')).toEqual([["side", ["a"]]]);
  });
});
