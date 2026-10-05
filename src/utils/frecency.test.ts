import { describe, it, expect } from "vite-plus/test";
import frecencySource from "./frecency.ts?raw";
import {
  EDIT_WEIGHT,
  HALF_LIFE_MS,
  MAX_AGE_MS,
  OPEN_WEIGHT,
  loadFrecency,
  mapPaths,
  note,
  parseStore,
  pruneStale,
  rankByFrecency,
  scoreOf,
  topFiles,
} from "./frecency";

const NOW = 1_770_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("what a file is worth", () => {
  it("counts an edit for more than an open", () => {
    const at = { lastAt: NOW };
    expect(scoreOf({ opens: 1, edits: 0, ...at }, NOW)).toBe(OPEN_WEIGHT);
    expect(scoreOf({ opens: 0, edits: 1, ...at }, NOW)).toBe(EDIT_WEIGHT);
  });

  it("halves the weight every half-life", () => {
    const stat = { opens: 8, edits: 0, lastAt: NOW - HALF_LIFE_MS };
    expect(scoreOf(stat, NOW)).toBeCloseTo(4, 10);
    expect(scoreOf({ ...stat, lastAt: NOW - HALF_LIFE_MS * 2 }, NOW)).toBeCloseTo(2, 10);
  });

  it("does not let a clock that went backwards inflate a record", () => {
    const stat = { opens: 3, edits: 0, lastAt: NOW + DAY };
    expect(scoreOf(stat, NOW)).toBe(3);
  });

  // The claim the whole module exists for.
  it("ranks a file edited this morning over one opened often a fortnight ago", () => {
    const stats = {
      "/ws/stale.ts": { opens: 20, edits: 0, lastAt: NOW - 14 * DAY },
      "/ws/today.ts": { opens: 1, edits: 1, lastAt: NOW - 4 * 60 * 60 * 1000 },
    };
    expect(rankByFrecency(Object.keys(stats), (p) => p, stats, NOW)).toEqual(["/ws/today.ts", "/ws/stale.ts"]);
  });
});

describe("recording a touch", () => {
  it("counts opens and edits apart and moves the record forward in time", () => {
    let store = note({}, "/ws", "/ws/a.ts", "open", NOW - DAY);
    store = note(store, "/ws", "/ws/a.ts", "edit", NOW);
    expect(store["/ws"]["/ws/a.ts"]).toEqual({ opens: 1, edits: 1, lastAt: NOW });
  });

  it("keeps each workspace's files to itself", () => {
    let store = note({}, "/ws/one", "/shared/a.ts", "open", NOW);
    store = note(store, "/ws/two", "/shared/a.ts", "edit", NOW);
    expect(store["/ws/one"]["/shared/a.ts"]).toMatchObject({ opens: 1, edits: 0 });
    expect(store["/ws/two"]["/shared/a.ts"]).toMatchObject({ opens: 0, edits: 1 });
  });

  it("drops the weakest once the workspace is over its cap", () => {
    let store: ReturnType<typeof note> = {};
    // Three old opens and one recent edit, capped at two.
    store = note(store, "/ws", "/ws/old1.ts", "open", NOW - 20 * DAY);
    store = note(store, "/ws", "/ws/old2.ts", "open", NOW - 20 * DAY);
    store = note(store, "/ws", "/ws/keep.ts", "edit", NOW, 2);
    expect(Object.keys(store["/ws"])).toContain("/ws/keep.ts");
    expect(Object.keys(store["/ws"])).toHaveLength(2);
  });
});

describe("ranking a list", () => {
  const stats = {
    "/ws/hot.ts": { opens: 4, edits: 2, lastAt: NOW },
    "/ws/warm.ts": { opens: 2, edits: 0, lastAt: NOW },
  };

  it("puts the tracked files first and leaves the untouched tail in its own order", () => {
    const all = ["/ws/z.ts", "/ws/warm.ts", "/ws/a.ts", "/ws/hot.ts", "/ws/m.ts"];
    expect(rankByFrecency(all, (p) => p, stats, NOW)).toEqual([
      "/ws/hot.ts",
      "/ws/warm.ts",
      "/ws/z.ts",
      "/ws/a.ts",
      "/ws/m.ts",
    ]);
  });

  it("does not touch the list it was given", () => {
    const all = ["/ws/z.ts", "/ws/hot.ts"];
    rankByFrecency(all, (p) => p, stats, NOW);
    expect(all).toEqual(["/ws/z.ts", "/ws/hot.ts"]);
  });

  it("ranks whatever it is given, not just paths", () => {
    const rows = [{ rel: "warm.ts" }, { rel: "hot.ts" }];
    expect(rankByFrecency(rows, (r) => `/ws/${r.rel}`, stats, NOW)).toEqual([{ rel: "hot.ts" }, { rel: "warm.ts" }]);
  });

  it("offers the top files with nothing typed", () => {
    expect(topFiles(stats, NOW, 1)).toEqual(["/ws/hot.ts"]);
    expect(topFiles({}, NOW, 5)).toEqual([]);
  });
});

describe("following a file that moved or is gone", () => {
  const store = {
    "/ws": {
      "/ws/old/a.ts": { opens: 2, edits: 1, lastAt: NOW },
      "/ws/keep.ts": { opens: 1, edits: 0, lastAt: NOW },
    },
  };

  it("repoints a renamed file's record", () => {
    const moved = mapPaths(store, (p) => (p.startsWith("/ws/old/") ? p.replace("/ws/old/", "/ws/new/") : p));
    expect(moved["/ws"]["/ws/new/a.ts"]).toEqual({ opens: 2, edits: 1, lastAt: NOW });
    expect(moved["/ws"]["/ws/old/a.ts"]).toBeUndefined();
  });

  it("merges rather than forgets when a rename lands on a tracked path", () => {
    const merged = mapPaths(store, (p) => (p === "/ws/old/a.ts" ? "/ws/keep.ts" : p));
    expect(merged["/ws"]["/ws/keep.ts"]).toEqual({ opens: 3, edits: 1, lastAt: NOW });
  });

  it("drops a trashed file, and the workspace with it once nothing is left", () => {
    const swept = mapPaths(store, () => null);
    expect(swept).toEqual({});
  });

  it("hands the same store back when nothing matched", () => {
    expect(mapPaths(store, (p) => p)).toBe(store);
  });
});

describe("what survives storage", () => {
  it("retires a record nobody has touched in a month", () => {
    const store = {
      "/ws": {
        "/ws/fresh.ts": { opens: 1, edits: 0, lastAt: NOW - DAY },
        "/ws/forgotten.ts": { opens: 9, edits: 9, lastAt: NOW - MAX_AGE_MS - DAY },
      },
    };
    expect(Object.keys(pruneStale(store, NOW)["/ws"])).toEqual(["/ws/fresh.ts"]);
  });

  it("reads anything that is not a store as nothing remembered", () => {
    expect(parseStore(null)).toEqual({});
    expect(parseStore("not json")).toEqual({});
    expect(parseStore("[]")).toEqual({});
    expect(parseStore(JSON.stringify({ "/ws": { "/ws/a.ts": { opens: "many" } } }))).toEqual({});
  });

  it("keeps the well-formed records beside a malformed one", () => {
    const raw = JSON.stringify({
      "/ws": { "/ws/good.ts": { opens: 1, edits: 2, lastAt: NOW }, "/ws/bad.ts": { opens: 1 } },
    });
    expect(parseStore(raw)).toEqual({ "/ws": { "/ws/good.ts": { opens: 1, edits: 2, lastAt: NOW } } });
  });

  it("survives storage being unavailable", () => {
    // Node has no localStorage, so this is the "quota or private mode" path.
    expect(loadFrecency(NOW)).toEqual({});
  });
});

// The architectural half of the ticket: Phase 6's omnibox ranks the same way,
// and it can only reuse this if the rule does not reach back into a picker.
it("stays free of any component import, so a picker is not required to use it", () => {
  const imports = [...frecencySource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  expect(imports.filter((p) => p.includes("components") || p.includes("panels"))).toEqual([]);
});
