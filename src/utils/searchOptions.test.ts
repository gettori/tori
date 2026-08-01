import { describe, it, expect } from "vitest";
import {
  DEFAULT_SEARCH_OPTIONS,
  TOGGLE_KEYS,
  countOccurrences,
  grepArgs,
  isUnsupported,
  splitHighlights,
  truncationNotice,
  type SearchOptions,
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
