import { describe, it, expect } from "vite-plus/test";
import { arrange, arrive, moveKeys, orderedKeys } from "./arrange";
import { DEFAULT_LANES, laneOf, laneOrder, type LaneConfig } from "../../utils/prLanes";
import type { PrChildState } from "../../utils/prChildState";

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

describe("arrange with lanes", () => {
  type L = { id: string; child: PrChildState | "unlaned" | "group" };
  const at = (id: string, child: L["child"]): L => ({ id, child });
  const sections = (entries: L[], cfg: LaneConfig, order: string[] = []) =>
    arrange(entries, {
      keysOf: (e) => [e.id],
      order,
      base: "main",
      lanes: {
        of: (e) => (e.id === "main" || e.child === "group" ? null : laneOf(e.child as PrChildState, cfg)),
        order: laneOrder(cfg),
        isGroup: (e) => e.child === "group",
      },
    }).map((s) => [s.id, s.shown.map((e) => e.id)]);
  const mix = [
    at("g", "group"),
    at("cr", "changesRequested"),
    at("main", "noPr"),
    at("rq", "reviewRequested"),
    at("rd", "reviewed"),
    at("wip", "draft"),
    at("ok", "approved"),
    at("rv", "ready"),
    at("m", "merged"),
    at("theirs", "unlaned"),
  ];

  it("leads with the base and the unlaned, then groups, then each lit child above its parent", () => {
    expect(sections(mix, DEFAULT_LANES)).toEqual([
      ["main", ["main", "theirs", "g"]],
      ["lane:working", ["wip"]],
      ["lane:changesRequested", ["cr"]],
      ["lane:approved", ["ok"]],
      ["lane:inReview", ["rv"]],
      ["lane:reviewRequested", ["rq"]],
      ["lane:reviewing", ["rd"]],
      ["lane:done", ["m"]],
    ]);
  });

  it("keeps every child in its parent when nothing is lit, and draws no empty lane", () => {
    expect(sections(mix, { ...DEFAULT_LANES, lit: [] }).map(([id]) => id)).toEqual([
      "main",
      "lane:working",
      "lane:inReview",
      "lane:reviewing",
      "lane:done",
    ]);
    expect(sections([at("wip", "draft")], { ...DEFAULT_LANES, lit: [] })).toEqual([
      ["main", []],
      ["lane:working", ["wip"]],
    ]);
  });

  it("folds Reviewing into In review, its lit children above In review", () => {
    expect(sections(mix, { ...DEFAULT_LANES, foldReviewing: true }).slice(2)).toEqual([
      ["lane:changesRequested", ["cr"]],
      ["lane:approved", ["ok"]],
      ["lane:reviewRequested", ["rq"]],
      ["lane:inReview", ["rd", "rv"]],
      ["lane:done", ["m"]],
    ]);
    expect(sections(mix, { ...DEFAULT_LANES, lit: [], foldReviewing: true }).slice(2)).toEqual([
      ["lane:inReview", ["cr", "rq", "rd", "ok", "rv"]],
      ["lane:done", ["m"]],
    ]);
  });
});

describe("arrive", () => {
  it("puts a branch that changed lane at the top of its new lane, until the next save", () => {
    const order = ["a", "b", "c", "d"];
    const last = { a: "working", b: "inReview", c: "inReview", d: "working" };
    const now = { ...last, d: "inReview" };
    expect(arrive(order, last, now)).toEqual(["a", "d", "b", "c"]);
    expect(arrive(["a", "d", "b", "c"], now, now)).toEqual(["a", "d", "b", "c"]);
  });

  it("sends the members of an ungrouped group to the top of their lanes", () => {
    const order = ["a", "g1", "b", "g2"];
    const last = { a: "working", g1: "group", b: "working", g2: "group" };
    const now = { a: "working", g1: "working", b: "working", g2: "done" };
    expect(arrive(order, last, now)).toEqual(["g2", "g1", "a", "b"]);
  });
});
