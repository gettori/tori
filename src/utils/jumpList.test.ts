import { describe, it, expect } from "vitest";
import {
  EMPTY_JUMPS,
  JUMP_LINE_THRESHOLD,
  canGoBack,
  canGoForward,
  current,
  isSignificantMove,
  listFor,
  mapPaths,
  mapPathsIn,
  record,
  recordIn,
  step,
  stepIn,
} from "./jumpList";

/** Record a run of positions into an empty list. */
const from = (...entries: { path: string; line?: number }[]) =>
  entries.reduce((list, e) => record(list, e), EMPTY_JUMPS);

describe("the jump list", () => {
  it("starts with nowhere to go", () => {
    expect(current(EMPTY_JUMPS)).toBeNull();
    expect(canGoBack(EMPTY_JUMPS)).toBe(false);
    expect(canGoForward(EMPTY_JUMPS)).toBe(false);
  });

  it("stands on the newest entry as positions are recorded", () => {
    const list = from({ path: "/a.ts", line: 1 }, { path: "/b.ts", line: 40 });
    expect(current(list)).toEqual({ path: "/b.ts", line: 40 });
    expect(canGoBack(list)).toBe(true);
    expect(canGoForward(list)).toBe(false);
  });

  it("walks back and forward over what was recorded", () => {
    const list = from({ path: "/a.ts", line: 1 }, { path: "/b.ts", line: 40 }, { path: "/c.ts", line: 9 });
    const back = step(step(list, -1), -1);
    expect(current(back)).toEqual({ path: "/a.ts", line: 1 });
    expect(canGoBack(back)).toBe(false);
    expect(current(step(back, 1))).toEqual({ path: "/b.ts", line: 40 });
  });

  it("refuses to step past either end, and says so by returning the same list", () => {
    const list = from({ path: "/a.ts", line: 1 });
    expect(step(list, -1)).toBe(list);
    expect(step(list, 1)).toBe(list);
  });

  // The rule that makes this a history rather than a ring: the branch you did
  // not take is gone, exactly as in a browser.
  it("truncates the forward leg when a new position is recorded after going back", () => {
    const list = from({ path: "/a.ts", line: 1 }, { path: "/b.ts", line: 40 }, { path: "/c.ts", line: 9 });
    const back = step(list, -1);
    expect(canGoForward(back)).toBe(true);
    const branched = record(back, { path: "/d.ts", line: 7 });
    expect(branched.entries).toEqual([
      { path: "/a.ts", line: 1 },
      { path: "/b.ts", line: 40 },
      { path: "/d.ts", line: 7 },
    ]);
    expect(canGoForward(branched)).toBe(false);
    expect(current(step(branched, -1))).toEqual({ path: "/b.ts", line: 40 });
  });

  it("ignores arriving where it already stands", () => {
    const list = from({ path: "/a.ts", line: 12 });
    expect(record(list, { path: "/a.ts", line: 12 })).toBe(list);
  });

  // Opening a file records the file; the caret landing inside it records a line
  // in that same file. Two entries for one destination would make the first
  // Back press look broken.
  it("refines a file-only entry in place rather than stacking a line on it", () => {
    const opened = record(EMPTY_JUMPS, { path: "/a.ts" });
    const landed = record(opened, { path: "/a.ts", line: 300 });
    expect(landed.entries).toEqual([{ path: "/a.ts", line: 300 }]);
    expect(canGoBack(landed)).toBe(false);
  });

  it("still appends a genuinely different line in the same file", () => {
    const list = from({ path: "/a.ts", line: 12 }, { path: "/a.ts", line: 300 });
    expect(list.entries).toHaveLength(2);
    expect(current(step(list, -1))).toEqual({ path: "/a.ts", line: 12 });
  });

  it("drops the oldest entries once it is over its cap, keeping the cursor on the newest", () => {
    let list = EMPTY_JUMPS;
    for (let i = 1; i <= 5; i++) list = record(list, { path: `/f${i}.ts`, line: i }, 3);
    expect(list.entries).toEqual([
      { path: "/f3.ts", line: 3 },
      { path: "/f4.ts", line: 4 },
      { path: "/f5.ts", line: 5 },
    ]);
    expect(current(list)).toEqual({ path: "/f5.ts", line: 5 });
    expect(canGoForward(list)).toBe(false);
  });
});

describe("what counts as a jump", () => {
  it("treats a one-line step as drift", () => {
    expect(isSignificantMove(40, 41)).toBe(false);
    expect(isSignificantMove(41, 40)).toBe(false);
    expect(isSignificantMove(40, 40)).toBe(false);
  });

  it("treats a move of at least the threshold as a jump, in either direction", () => {
    expect(isSignificantMove(40, 40 + JUMP_LINE_THRESHOLD)).toBe(true);
    expect(isSignificantMove(40, 40 - JUMP_LINE_THRESHOLD)).toBe(true);
    expect(isSignificantMove(40, 39 + JUMP_LINE_THRESHOLD)).toBe(false);
  });
});

describe("following a file that moved or is gone", () => {
  const gone = (under: string) => (p: string) => (p === under || p.startsWith(`${under}/`) ? null : p);

  it("repoints every entry a rename touched, leaving the cursor where it stood", () => {
    const list = from({ path: "/ws/old/a.ts", line: 3 }, { path: "/ws/keep.ts" }, { path: "/ws/old/b.ts", line: 9 });
    const moved = mapPaths(list, (p) => (p.startsWith("/ws/old/") ? p.replace("/ws/old/", "/ws/new/") : p));
    expect(moved.entries).toEqual([
      { path: "/ws/new/a.ts", line: 3 },
      { path: "/ws/keep.ts" },
      { path: "/ws/new/b.ts", line: 9 },
    ]);
    expect(current(moved)).toEqual({ path: "/ws/new/b.ts", line: 9 });
  });

  it("drops the entries under a trashed folder", () => {
    const list = from({ path: "/ws/a.ts" }, { path: "/ws/junk/x.ts" }, { path: "/ws/junk/y.ts" }, { path: "/ws/b.ts" });
    const swept = mapPaths(list, gone("/ws/junk"));
    expect(swept.entries).toEqual([{ path: "/ws/a.ts" }, { path: "/ws/b.ts" }]);
    expect(current(swept)).toEqual({ path: "/ws/b.ts" });
  });

  // Losing the entry you were standing on must not leave the cursor pointing at
  // whatever slid into its slot, or Back would walk forwards.
  it("stands on the newest survivor before the one it lost", () => {
    const list = step(
      from({ path: "/ws/a.ts" }, { path: "/ws/b.ts" }, { path: "/ws/junk/x.ts" }, { path: "/ws/d.ts" }),
      -1,
    );
    expect(current(list)).toEqual({ path: "/ws/junk/x.ts" });
    const swept = mapPaths(list, gone("/ws/junk"));
    expect(current(swept)).toEqual({ path: "/ws/b.ts" });
    expect(canGoForward(swept)).toBe(true);
    expect(current(step(swept, 1))).toEqual({ path: "/ws/d.ts" });
  });

  it("falls back to the oldest survivor when nothing before it lived", () => {
    const list = from({ path: "/ws/junk/x.ts" }, { path: "/ws/b.ts" });
    const swept = mapPaths(step(list, -1), gone("/ws/junk"));
    expect(current(swept)).toEqual({ path: "/ws/b.ts" });
    expect(canGoBack(swept)).toBe(false);
  });

  it("empties out when every place is gone", () => {
    const swept = mapPaths(from({ path: "/ws/junk/x.ts" }, { path: "/ws/junk/y.ts" }), gone("/ws/junk"));
    expect(swept.entries).toEqual([]);
    expect(current(swept)).toBeNull();
    expect(canGoBack(swept)).toBe(false);
    expect(canGoForward(swept)).toBe(false);
  });

  it("hands the same list and store back when nothing matched", () => {
    const list = from({ path: "/ws/a.ts" });
    expect(mapPaths(list, (p) => p)).toBe(list);
    const store = recordIn({}, "/ws", { path: "/ws/a.ts" });
    expect(mapPathsIn(store, (p) => p)).toBe(store);
  });

  it("sweeps every workspace, not only one", () => {
    let store = recordIn({}, "/ws/one", { path: "/shared/gone.ts" });
    store = recordIn(store, "/ws/two", { path: "/shared/gone.ts" });
    const swept = mapPathsIn(store, gone("/shared"));
    expect(listFor(swept, "/ws/one").entries).toEqual([]);
    expect(listFor(swept, "/ws/two").entries).toEqual([]);
  });
});

describe("one list per workspace", () => {
  it("keeps two workspaces' histories apart", () => {
    let store = recordIn({}, "/space/proj/main", { path: "/space/proj/main/a.ts", line: 3 });
    store = recordIn(store, "/space/proj/main", { path: "/space/proj/main/b.ts", line: 9 });
    store = recordIn(store, "/space/proj/feat", { path: "/space/proj/feat/a.ts", line: 1 });

    expect(canGoBack(listFor(store, "/space/proj/main"))).toBe(true);
    expect(canGoBack(listFor(store, "/space/proj/feat"))).toBe(false);

    const back = stepIn(store, "/space/proj/main", -1);
    expect(current(listFor(back, "/space/proj/main"))).toEqual({ path: "/space/proj/main/a.ts", line: 3 });
    // Stepping one workspace must not move another's cursor.
    expect(listFor(back, "/space/proj/feat")).toBe(listFor(store, "/space/proj/feat"));
  });

  it("reads an untouched workspace as empty", () => {
    expect(listFor({}, "/nowhere")).toBe(EMPTY_JUMPS);
  });

  it("hands the same store back on a no-op, so a signal holding it does not churn", () => {
    const store = recordIn({}, "/ws", { path: "/ws/a.ts", line: 5 });
    expect(recordIn(store, "/ws", { path: "/ws/a.ts", line: 5 })).toBe(store);
    expect(stepIn(store, "/ws", 1)).toBe(store);
    expect(stepIn(store, "/ws", -1)).toBe(store);
  });
});
