// Where a query matched, and the one property that matters about it: the marks
// have to agree with the matcher that put the row on screen and the badge that
// counted it. A row shown with nothing marked reads as a filter bug; a mark
// where the matcher found nothing claims a reason that is not the real one.
import { describe, it, expect } from "vite-plus/test";
import { hintRanges, labelRanges, segments } from "./searchHighlight";
import { matchingEntries } from "./settingsSearch";
import { SETTINGS } from "../../../utils/settingsCatalog";

/** The marked pieces of `text`, which is what a reader actually sees bolded. */
const marks = (text: string, ranges: { start: number; end: number }[]) =>
  segments(text, ranges)
    .filter((s) => s.marked)
    .map((s) => s.text);

describe("marking where a label matched", () => {
  it("marks a contiguous run as one piece", () => {
    expect(marks("Minimap", labelRanges("mini", "Minimap"))).toEqual(["Mini"]);
  });

  it("marks the scattered characters of a loose match", () => {
    // "sfw" for "Soft wrap long lines": the looseness is the point on a short
    // label, and the marks show which characters earned it.
    expect(marks("Soft wrap long lines", labelRanges("sfw", "Soft wrap long lines"))).toEqual([
      "S",
      "f",
      "w",
    ]);
  });

  it("marks nothing when the query is not a subsequence", () => {
    expect(labelRanges("zzz", "Minimap")).toEqual([]);
  });

  it("ignores case and surrounding space", () => {
    expect(marks("Minimap", labelRanges("  MINI ", "Minimap"))).toEqual(["Mini"]);
  });

  it("marks nothing for an empty query", () => {
    expect(labelRanges("", "Minimap")).toEqual([]);
    expect(labelRanges("   ", "Minimap")).toEqual([]);
  });
});

describe("marking where a hint matched", () => {
  it("marks the substring occurrence", () => {
    expect(marks("Runs the project's own Biome", hintRanges("Biome", "Runs the project's own Biome"))).toEqual(
      ["Biome"],
    );
  });

  it("marks nothing for a subsequence that is not a substring", () => {
    // The hint rule is deliberately stricter than the label rule: prose swallows
    // any subsequence, so a loose match here would mark noise.
    expect(hintRanges("rtp", "Runs the project")).toEqual([]);
  });

  it("copes with no hint at all", () => {
    expect(hintRanges("x", undefined)).toEqual([]);
  });
});

describe("splitting text into marked and plain pieces", () => {
  it("covers the whole string, in order", () => {
    for (const [text, ranges] of [
      ["Minimap", labelRanges("mini", "Minimap")],
      ["Soft wrap", labelRanges("sfw", "Soft wrap")],
      ["Minimap", []],
    ] as const) {
      expect(segments(text, [...ranges]).map((s) => s.text).join("")).toBe(text);
    }
  });

  it("returns the whole string unmarked when nothing matched", () => {
    expect(segments("Minimap", [])).toEqual([{ text: "Minimap", marked: false }]);
  });
});

describe("agreeing with the matcher", () => {
  it("marks something in every entry the search counted", () => {
    // The invariant behind the badges: a row on screen because it matched must
    // be able to show *why*, in its label or in its hint.
    for (const q of ["font", "minim", "sfw", "Dollars", "stop", "e"]) {
      const m = matchingEntries(q)!;
      for (const s of SETTINGS.filter((s) => m.ids.has(s.id))) {
        const marked = labelRanges(q, s.label).length + hintRanges(q, s.hint).length;
        expect(marked, `${q} matched ${s.id} but marks nothing in it`).toBeGreaterThan(0);
      }
    }
  });

  it("marks nothing in an entry the search rejected", () => {
    // The other direction: a mark the filter disagrees with would explain a row
    // that is not on screen, or claim the wrong reason for one that is.
    for (const q of ["font", "minim", "Dollars", "zzzqqq"]) {
      const m = matchingEntries(q)!;
      for (const s of SETTINGS.filter((s) => !m.ids.has(s.id))) {
        const marked = labelRanges(q, s.label).length + hintRanges(q, s.hint).length;
        expect(marked, `${q} rejected ${s.id} but marks something in it`).toBe(0);
      }
    }
  });
});
