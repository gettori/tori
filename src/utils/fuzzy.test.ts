// One walk, two answers: the verdict that filters and the ranges that mark
// come from the same greedy pass. That property is what every consumer leans
// on - a mark can never land on a character that did not earn the match - and
// it is what these tests pin.
import { describe, it, expect } from "vitest";
import { fuzzyMatch, fuzzyScore } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("is null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "sonnet")).toBeNull();
    // The right letters in the wrong order are still no match.
    expect(fuzzyMatch("tennos", "sonnet")).toBeNull();
  });

  it("matches case-insensitively and merges adjacent hits into one run", () => {
    expect(fuzzyMatch("soft", "Soft wrap")!.ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it("walks greedily: the first available character wins", () => {
    // "snt" in "sonnet": s(0), the *first* n(2), t(5). A cleverer walk could
    // pick the second n for a prettier run, but then every consumer would need
    // the same cleverness or marks would disagree with filters.
    expect(fuzzyMatch("snt", "sonnet")!.ranges).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 5, end: 6 },
    ]);
  });

  it("scores a contiguous run above the same letters scattered", () => {
    expect(fuzzyMatch("net", "sonnet")!.score).toBeGreaterThan(fuzzyMatch("net", "n e t")!.score);
  });

  it("matches everything on an empty query, marking nothing", () => {
    // What lets a filter box treat "no query" and "query" through one path.
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, ranges: [] });
  });
});

describe("fuzzyScore, the path-flavoured derivation", () => {
  // Derived from fuzzyMatch's ranges rather than walked a second time. These
  // pin the exact numbers the old standalone implementation produced, so the
  // refactor is provably a refactor.
  it("keeps the basename bonus", () => {
    // "app" lands entirely in the basename: a=1+1, then two contiguous
    // p's at 3+1 each.
    expect(fuzzyScore("app", "src/App.tsx")).toBe(10);
  });

  it("gives no basename bonus to directory hits", () => {
    // "src" is one contiguous run before the slash: 1+3+3, nothing added.
    expect(fuzzyScore("src", "src/App.tsx")).toBe(7);
  });

  it("is null on a non-subsequence", () => {
    expect(fuzzyScore("zz", "src/App.tsx")).toBeNull();
  });
});
