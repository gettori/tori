import { describe, it, expect } from "vite-plus/test";

// The rules a breakpoint follows before any adapter has heard of it: where a
// line is kept, what a second click does, and what is left behind when the last
// one in a file goes. `debugBreakpoints.ts` owns the wire and is tested on its
// own; nothing here knows a session exists.

import {
  breakpointFiles,
  breakpointsFor,
  isBreakpoint,
  loadBreakpoints,
  mapBreakpointPaths,
  parseBreakpointStore,
  setFileBreakpoints,
  toggleBreakpoint,
  type BreakpointStore,
} from "./breakpoints";

const WS = "/space/proj/main";
const OTHER = "/space/proj/feature";
const FILE = `${WS}/src/index.ts`;

describe("setting and clearing", () => {
  it("toggles a line on and back off", () => {
    const on = toggleBreakpoint({}, WS, FILE, 12);
    expect(breakpointsFor(on, WS, FILE)).toEqual([12]);
    expect(isBreakpoint(on, WS, FILE, 12)).toBe(true);

    const off = toggleBreakpoint(on, WS, FILE, 12);
    // The gutter has one gesture, so the same click has to be able to undo
    // itself; there is nowhere else to click to remove one.
    expect(isBreakpoint(off, WS, FILE, 12)).toBe(false);
  });

  it("keeps lines ascending however they were added", () => {
    let store: BreakpointStore = {};
    for (const line of [30, 4, 17]) store = toggleBreakpoint(store, WS, FILE, line);
    // Sorted here rather than at each read, so the gutter and the
    // `setBreakpoints` payload cannot disagree about the order.
    expect(breakpointsFor(store, WS, FILE)).toEqual([4, 17, 30]);
  });

  it("keeps each workspace's lines apart", () => {
    const store = toggleBreakpoint(toggleBreakpoint({}, WS, FILE, 3), OTHER, FILE, 9);
    // The same absolute path can be open in two worktrees, and a line in one is
    // not a line in the other.
    expect(breakpointsFor(store, WS, FILE)).toEqual([3]);
    expect(breakpointsFor(store, OTHER, FILE)).toEqual([9]);
  });
});

describe("what is left behind", () => {
  it("drops the file and then the workspace when the last line goes", () => {
    const on = toggleBreakpoint({}, WS, FILE, 5);
    const off = toggleBreakpoint(on, WS, FILE, 5);
    // An empty record would outlive every breakpoint in it and be written to
    // storage forever.
    expect(off).toEqual({});
  });

  it("keeps a workspace that still has another file", () => {
    const two = setFileBreakpoints(toggleBreakpoint({}, WS, FILE, 5), WS, `${WS}/src/b.ts`, [2]);
    const one = setFileBreakpoints(two, WS, FILE, []);
    expect(Object.keys(one[WS])).toEqual([`${WS}/src/b.ts`]);
  });

  it("returns the same store when nothing changed", () => {
    const store = toggleBreakpoint({}, WS, FILE, 5);
    // Identity, not equality: this store is held in a signal, and a fresh object
    // would re-run every effect reading it, including the one that re-sends
    // `setBreakpoints` to a live adapter.
    expect(setFileBreakpoints(store, WS, FILE, [5])).toBe(store);
    expect(setFileBreakpoints(store, WS, FILE, [5, 5])).toBe(store);
    expect(setFileBreakpoints({}, WS, FILE, [])).toEqual({});
  });
});

describe("listing a workspace's files", () => {
  it("gives each file's lines, paths sorted", () => {
    let store: BreakpointStore = {};
    store = setFileBreakpoints(store, WS, `${WS}/src/z.ts`, [2]);
    store = setFileBreakpoints(store, WS, `${WS}/src/a.ts`, [9, 1]);
    // Sorted so a session's configuration walks them in an order that does not
    // move between runs.
    expect(breakpointFiles(store, WS)).toEqual([
      { path: `${WS}/src/a.ts`, lines: [1, 9] },
      { path: `${WS}/src/z.ts`, lines: [2] },
    ]);
    expect(breakpointFiles(store, OTHER)).toEqual([]);
  });
});

describe("a file that moved or is gone", () => {
  it("rewrites the path, across every workspace", () => {
    const moved = `${WS}/src/renamed.ts`;
    let store: BreakpointStore = setFileBreakpoints({}, WS, FILE, [3]);
    store = setFileBreakpoints(store, OTHER, FILE, [9]);

    const next = mapBreakpointPaths(store, (p) => (p === FILE ? moved : p));

    // A folder renamed on disk is renamed for every worktree at once, and the
    // ones off screen are exactly the breakpoints nobody would notice going
    // stale.
    expect(breakpointsFor(next, WS, moved)).toEqual([3]);
    expect(breakpointsFor(next, OTHER, moved)).toEqual([9]);
    expect(breakpointsFor(next, WS, FILE)).toEqual([]);
  });

  it("merges onto a path that already had some", () => {
    const other = `${WS}/src/b.ts`;
    let store: BreakpointStore = setFileBreakpoints({}, WS, FILE, [3, 8]);
    store = setFileBreakpoints(store, WS, other, [8, 12]);

    const next = mapBreakpointPaths(store, (p) => (p === FILE ? other : p));

    // They are the same file now, and dropping either side would throw away
    // something set by hand.
    expect(breakpointsFor(next, WS, other)).toEqual([3, 8, 12]);
  });

  it("drops a trashed file, and the workspace it emptied", () => {
    const store = setFileBreakpoints({}, WS, FILE, [3]);
    // Nothing can ever remove these otherwise: a trashed file has no gutter.
    expect(mapBreakpointPaths(store, () => null)).toEqual({});
  });

  it("returns the same store when nothing moved", () => {
    const store = setFileBreakpoints({}, WS, FILE, [3]);
    expect(mapBreakpointPaths(store, (p) => p)).toBe(store);
  });
});

describe("reading what was stored", () => {
  it("survives anything that is not a store", () => {
    expect(parseBreakpointStore(null)).toEqual({});
    expect(parseBreakpointStore("{not json")).toEqual({});
    expect(parseBreakpointStore("[]")).toEqual({});
    expect(parseBreakpointStore(JSON.stringify({ [WS]: "nope" }))).toEqual({});
  });

  it("drops lines no editor could scroll to", () => {
    const raw = JSON.stringify({ [WS]: { [FILE]: [0, -3, 2.5, "7", 4, 4] } });
    // A file left with nothing keeps no entry, so a corrupted write does not
    // resurrect as an empty file forever.
    expect(parseBreakpointStore(raw)).toEqual({ [WS]: { [FILE]: [4] } });
    expect(parseBreakpointStore(JSON.stringify({ [WS]: { [FILE]: [0] } }))).toEqual({});
  });

  it("survives storage being unavailable", () => {
    // Node has no `localStorage`, which is the same shape as private mode: the
    // reader answers "nothing set" rather than throwing on startup.
    expect(loadBreakpoints()).toEqual({});
  });
});
