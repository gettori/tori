import { describe, it, expect } from "vite-plus/test";
import { arrange, moveKeys, orderedKeys } from "./arrange";

type E = { id: string; keys: string[] };
const row = (k: string): E => ({ id: k, keys: [k] });
const stack = (id: string, ...keys: string[]): E => ({ id, keys });
const ids = (entries: E[]) => entries.map((e) => e.id);
const keysOf = (e: E) => e.keys;

describe("arrange", () => {
  it("puts what has no rank yet on top, in the order it came", () => {
    const [main] = arrange([row("a"), row("new1"), row("b"), row("new2")], { keysOf, order: ["b", "a"] });
    expect(ids(main.shown)).toEqual(["new1", "new2", "b", "a"]);
  });

  it("leads with the base branch whatever the saved order says", () => {
    const [main] = arrange([row("a"), row("main"), row("new")], { keysOf, order: ["a", "main"], base: "main" });
    expect(ids(main.shown)).toEqual(["main", "new", "a"]);
  });

  it("ranks a stack as one entry, at its best-placed layer", () => {
    const entries = [row("a"), stack("s", "s1", "s2"), row("b")];
    const [main] = arrange(entries, { keysOf, order: ["b", "s2", "a", "s1"] });
    expect(ids(main.shown)).toEqual(["b", "s", "a"]);
  });

  it("cuts the section at the cap and keeps the selected entry in its place", () => {
    const keys = ["a", "b", "c", "d"];
    const cap = { size: 2, keep: (e: E) => e.id === "d", open: false };
    const [main] = arrange(keys.map(row), { keysOf, order: keys, cap });
    expect(ids(main.shown)).toEqual(["a", "b", "d"]);
    expect(ids(main.hidden)).toEqual(["c"]);

    const [open] = arrange(keys.map(row), { keysOf, order: keys, cap: { ...cap, open: true } });
    expect(ids(open.shown)).toEqual(keys);
  });
});

describe("orderedKeys and moveKeys", () => {
  it("saves new keys on top and the base first", () => {
    expect(orderedKeys(["a", "main", "z"], ["a"], "main")).toEqual(["main", "z", "a"]);
  });

  it("moves a block of keys before or after a target's block", () => {
    const order = ["a", "s1", "s2", "b", "c"];
    expect(moveKeys(order, ["c"], ["s1", "s2"], "before")).toEqual(["a", "c", "s1", "s2", "b"]);
    expect(moveKeys(order, ["s1", "s2"], ["c"], "after")).toEqual(["a", "b", "c", "s1", "s2"]);
    expect(moveKeys(order, ["a"], ["gone"], "after")).toEqual(order);
  });
});
