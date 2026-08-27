import { describe, it, expect } from "vitest";
import {
  DEFAULT_SEARCH_OPTIONS,
  TOGGLE_KEYS,
  countOccurrences,
  dirtyRelativePaths,
  grepArgs,
  isUnsupported,
  mergeSearchResults,
  replaceOutcome,
  replaceTargets,
  splitHighlights,
  truncationNotice,
  unionUnsupported,
  type SearchOptions,
  type SearchResult,
} from "./searchOptions";

describe("defaults", () => {
  it("starts every toggle off and every glob empty", () => {
    expect(DEFAULT_SEARCH_OPTIONS).toEqual({
      case: false,
      regex: false,
      wholeWord: false,
      include: "",
      exclude: "",
      noIgnore: false,
    });
  });

  it("lists every boolean toggle in TOGGLE_KEYS", () => {
    const booleans = Object.entries(DEFAULT_SEARCH_OPTIONS)
      .filter(([, v]) => typeof v === "boolean")
      .map(([k]) => k)
      .sort();
    expect([...TOGGLE_KEYS].sort()).toEqual(booleans);
  });
});

describe("grepArgs", () => {
  // Every combination of the four booleans, so a renamed or dropped key fails
  // here rather than as an empty result set at runtime.
  const combos: SearchOptions[] = [];
  for (const c of [false, true])
    for (const r of [false, true])
      for (const w of [false, true])
        for (const n of [false, true])
          combos.push({ case: c, regex: r, wholeWord: w, include: "", exclude: "", noIgnore: n });

  it.each(combos)("round-trips %o", (options) => {
    const args = grepArgs("/proj", "needle", options, 500);
    expect(args).toEqual({ root: "/proj", query: "needle", options, max: 500 });
    expect(Object.keys(args.options).sort()).toEqual([
      "case",
      "exclude",
      "include",
      "noIgnore",
      "regex",
      "wholeWord",
    ]);
  });

  it("passes globs through verbatim", () => {
    const options = { ...DEFAULT_SEARCH_OPTIONS, include: "src/**/*.ts", exclude: "**/*.test.ts" };
    expect(grepArgs("/p", "q", options, 10).options).toMatchObject({
      include: "src/**/*.ts",
      exclude: "**/*.test.ts",
    });
  });
});

describe("isUnsupported", () => {
  it("matches the wire name a backend reports", () => {
    expect(isUnsupported(["noIgnore"], "noIgnore")).toBe(true);
    expect(isUnsupported(["noIgnore"], "case")).toBe(false);
    expect(isUnsupported([], "noIgnore")).toBe(false);
  });

  it("uses keys that exist on the options object", () => {
    // Guards the drift the Rust side could introduce: `unsupported` carries
    // camelCase wire names, and these keys must be exactly those.
    for (const k of TOGGLE_KEYS) expect(k in DEFAULT_SEARCH_OPTIONS).toBe(true);
  });
});

describe("countOccurrences", () => {
  it("sums spans, not rows", () => {
    const matches = [
      { submatches: [[0, 2] as [number, number], [6, 8] as [number, number]] },
      { submatches: [[1, 3] as [number, number]] },
    ];
    expect(countOccurrences(matches)).toBe(3);
  });

  it("is zero for no matches", () => {
    expect(countOccurrences([])).toBe(0);
  });
});

describe("truncationNotice", () => {
  it("says nothing when the results fit", () => {
    expect(truncationNotice(false, 500, 12)).toBeNull();
  });

  it("names lines and occurrences separately", () => {
    expect(truncationNotice(true, 500, 612)).toBe(
      "First 500 matching lines shown (612 occurrences). Refine your search.",
    );
  });

  it("singularises one occurrence", () => {
    expect(truncationNotice(true, 1, 1)).toContain("(1 occurrence)");
  });
});

describe("dirtyRelativePaths", () => {
  it("drops falsy entries, which is how the editor records a saved file", () => {
    expect(
      dirtyRelativePaths("/proj", { "/proj/a.ts": true, "/proj/b.ts": false }),
    ).toEqual(["a.ts"]);
  });

  it("ignores paths outside the root", () => {
    expect(dirtyRelativePaths("/proj", { "/elsewhere/a.ts": true })).toEqual([]);
  });

  it("does not treat a sibling sharing the root's prefix as inside it", () => {
    // The bug a bare startsWith(root) would have: /proj-old is not in /proj.
    expect(
      dirtyRelativePaths("/proj", { "/proj-old/a.ts": true, "/proj/b.ts": true }),
    ).toEqual(["b.ts"]);
  });

  it("tolerates a root with a trailing slash", () => {
    expect(dirtyRelativePaths("/proj/", { "/proj/sub/a.ts": true })).toEqual(["sub/a.ts"]);
  });

  it("keeps nested paths relative to the root", () => {
    expect(dirtyRelativePaths("/proj", { "/proj/src/deep/a.ts": true })).toEqual(["src/deep/a.ts"]);
  });
});

describe("replaceTargets", () => {
  const m = (path: string, line: number, submatches: [number, number][]) => ({
    path,
    line,
    submatches,
  });

  it("groups spans per file and attaches that file's digest", () => {
    const targets = replaceTargets(
      [m("a.ts", 1, [[0, 2], [5, 7]]), m("a.ts", 3, [[1, 3]]), m("b.ts", 2, [[0, 1]])],
      [
        { path: "a.ts", digest: "d1" },
        { path: "b.ts", digest: "d2" },
      ],
      [],
    );
    expect(targets).toEqual([
      {
        path: "a.ts",
        digest: "d1",
        matches: [
          { line: 1, start: 0, end: 2 },
          { line: 1, start: 5, end: 7 },
          { line: 3, start: 1, end: 3 },
        ],
      },
      { path: "b.ts", digest: "d2", matches: [{ line: 2, start: 0, end: 1 }] },
    ]);
  });

  it("drops a file with unsaved edits", () => {
    const targets = replaceTargets(
      [m("a.ts", 1, [[0, 2]]), m("b.ts", 1, [[0, 2]])],
      [
        { path: "a.ts", digest: "d1" },
        { path: "b.ts", digest: "d2" },
      ],
      ["a.ts"],
    );
    expect(targets.map((t) => t.path)).toEqual(["b.ts"]);
  });

  it("drops a file the search returned no digest for", () => {
    // Nothing to prove it has not moved, so it must not be written.
    const targets = replaceTargets([m("a.ts", 1, [[0, 2]])], [], []);
    expect(targets).toEqual([]);
  });
});

describe("replaceOutcome", () => {
  it("reports counts with nothing skipped", () => {
    expect(replaceOutcome(12, ["a", "b"], [])).toBe("Replaced 12 occurrences in 2 files.");
  });

  it("singularises one occurrence in one file", () => {
    expect(replaceOutcome(1, ["a"], [])).toBe("Replaced 1 occurrence in 1 file.");
  });

  it("keeps skip reasons distinguishable, since they ask for different things", () => {
    const out = replaceOutcome(12, ["a"], [
      { path: "x", reason: "unsaved changes" },
      { path: "y", reason: "unsaved changes" },
      { path: "z", reason: "changed on disk" },
    ]);
    expect(out).toBe(
      "Replaced 12 occurrences in 1 file, 2 skipped (unsaved changes), 1 skipped (changed on disk).",
    );
  });

  it("sums two members' outcomes into one sentence that names both skips", () => {
    // A fan-out is one act, so it reports once. The member is inside the reason
    // because the counts are grouped by it: two members hold the same
    // `src/index.ts`, and a bare path names neither of them.
    const api = { changed: ["src/a.ts"], skipped: [{ path: "src/index.ts", reason: "changed on disk in Payments API" }], occurrences: 3 };
    const web = { changed: ["src/b.ts"], skipped: [{ path: "src/index.ts", reason: "unsaved changes in Web App" }], occurrences: 2 };
    expect(
      replaceOutcome(
        api.occurrences + web.occurrences,
        [...api.changed, ...web.changed],
        [...api.skipped, ...web.skipped],
      ),
    ).toBe(
      "Replaced 5 occurrences in 2 files, 1 skipped (changed on disk in Payments API), 1 skipped (unsaved changes in Web App).",
    );
  });
});

describe("splitHighlights", () => {
  it("splits a single match into three segments", () => {
    expect(splitHighlights("a needle b", [[2, 8]])).toEqual([
      { text: "a ", hit: false },
      { text: "needle", hit: true },
      { text: " b", hit: false },
    ]);
  });

  it("highlights two occurrences on one line", () => {
    expect(splitHighlights("ab cd ab", [[0, 2], [6, 8]])).toEqual([
      { text: "ab", hit: true },
      { text: " cd ", hit: false },
      { text: "ab", hit: true },
    ]);
  });

  it("handles a match at each edge", () => {
    expect(splitHighlights("abc", [[0, 3]])).toEqual([{ text: "abc", hit: true }]);
    expect(splitHighlights("xabc", [[0, 1]])).toEqual([
      { text: "x", hit: true },
      { text: "abc", hit: false },
    ]);
  });

  it("uses UTF-16 offsets, matching what the backend emits", () => {
    // "café " is 5 UTF-16 units and 6 bytes; the backend converts, so offset 5
    // must land on the "n". Byte offsets would slice one character late.
    expect(splitHighlights("café needle", [[5, 11]])).toEqual([
      { text: "café ", hit: false },
      { text: "needle", hit: true },
    ]);
  });

  it("renders plainly when there are no spans", () => {
    expect(splitHighlights("plain", [])).toEqual([{ text: "plain", hit: false }]);
    expect(splitHighlights("", [])).toEqual([]);
  });

  it("survives malformed spans without losing text", () => {
    const join = (segs: { text: string }[]) => segs.map((s) => s.text).join("");
    // Out of range, inverted, unsorted, and overlapping in turn.
    for (const spans of [
      [[0, 99]],
      [[4, 2]],
      [[6, 8], [0, 2]],
      [[0, 4], [2, 6]],
      [[-3, 2]],
    ] as [number, number][][]) {
      expect(join(splitHighlights("ab cd ab", spans))).toBe("ab cd ab");
    }
  });
});

describe("mergeSearchResults", () => {
  const result = (over: Partial<SearchResult> = {}): SearchResult => ({
    matches: [],
    truncated: false,
    backend: "rg",
    unsupported: [],
    files: [],
    ...over,
  });
  const hit = (path: string) => ({ path, line: 1, text: "needle", submatches: [[0, 6]] as [number, number][] });

  const FAN = [
    {
      root: "/feat/api",
      result: result({
        matches: [hit("src/main.rs")],
        files: [{ path: "src/main.rs", digest: "a" }],
        truncated: true,
      }),
    },
    {
      root: "/feat/web",
      result: result({ matches: [hit("src/App.tsx")], backend: "plain", unsupported: ["noIgnore"] }),
    },
    { root: "/feat/docs", error: "grep: permission denied" },
  ];

  it("keeps one section per root, in the order the legs came in", () => {
    expect(mergeSearchResults(FAN).sections.map((s) => s.root)).toEqual([
      "/feat/api",
      "/feat/web",
      "/feat/docs",
    ]);
  });

  it("keeps truncation on the section that hit the cap, not the whole set", () => {
    const [api, web] = mergeSearchResults(FAN).sections;
    expect(api.truncated).toBe(true);
    expect(web.truncated).toBe(false);
  });

  it("unions the options no searched backend can honour", () => {
    expect(mergeSearchResults(FAN).unsupported).toEqual(["noIgnore"]);
  });

  it("gives a failed root its own section and leaves the others intact", () => {
    const { sections } = mergeSearchResults(FAN);
    expect(sections[2]).toEqual({
      root: "/feat/docs",
      matches: [],
      files: [],
      truncated: false,
      backend: "",
      unsupported: [],
      error: "grep: permission denied",
    });
    expect(sections[0].matches).toHaveLength(1);
    expect(sections[1].matches).toHaveLength(1);
  });

  it("carries each root's digests separately, so a replace stays fenced", () => {
    const { sections } = mergeSearchResults(FAN);
    expect(sections[0].files).toEqual([{ path: "src/main.rs", digest: "a" }]);
    expect(sections[1].files).toEqual([]);
  });

  it("merges nothing into nothing", () => {
    expect(mergeSearchResults([])).toEqual({ sections: [], unsupported: [] });
  });
});

describe("unionUnsupported", () => {
  it("de-duplicates and keeps first-seen order", () => {
    const r = (unsupported: string[]): SearchResult => ({
      matches: [],
      truncated: false,
      backend: "plain",
      unsupported,
      files: [],
    });
    expect(unionUnsupported([r(["noIgnore", "wholeWord"]), r(["wholeWord"]), r(["regex"])])).toEqual([
      "noIgnore",
      "wholeWord",
      "regex",
    ]);
  });

  it("ignores a root that never answered", () => {
    expect(unionUnsupported([null, undefined])).toEqual([]);
  });
});
