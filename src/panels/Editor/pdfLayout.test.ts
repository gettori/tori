import { describe, expect, it } from "vite-plus/test";
import {
  COLUMN_PADDING,
  CSS_PER_PT,
  MAX_CANVAS_PIXELS,
  MAX_PERCENT,
  MIN_PERCENT,
  PAGE_GAP,
  clampPage,
  clampPercent,
  fitPageScale,
  fitWidthScale,
  pageTops,
  pageWindow,
  parsePercent,
  percentOf,
  placeAt,
  renderScale,
  scaleFor,
  scrollTopFor,
  zoomStep,
} from "./pdfLayout";

// US Letter at 72dpi, which is what `getViewport({ scale: 1 })` answers with.
const LETTER = { width: 612, height: 792 };

describe("fitWidthScale", () => {
  it("fills the viewport's width minus the column's own padding", () => {
    expect(fitWidthScale(612 + COLUMN_PADDING * 2, LETTER)).toBe(1);
    expect(fitWidthScale(306 + COLUMN_PADDING * 2, LETTER)).toBe(0.5);
  });

  it("answers 1 for a viewport that has not been measured yet", () => {
    // Before the first ResizeObserver callback, and under jsdom for good. A
    // negative or zero scale would collapse every page to nothing.
    expect(fitWidthScale(0, LETTER)).toBe(1);
    expect(fitWidthScale(10, LETTER)).toBe(1);
    expect(fitWidthScale(800, { width: 0, height: 0 })).toBe(1);
  });
});

describe("renderScale", () => {
  it("rasterises at the device pixel ratio when that fits under the ceiling", () => {
    expect(renderScale(1, LETTER, 2)).toBe(2);
  });

  it("caps at the pixel ceiling rather than asking for a canvas that paints nothing", () => {
    const capped = renderScale(4, LETTER, 2, MAX_CANVAS_PIXELS);
    expect(capped).toBeLessThan(8);
    expect(LETTER.width * capped * (LETTER.height * capped)).toBeCloseTo(MAX_CANVAS_PIXELS, 0);
  });

  it("caps rather than refusing, so a huge page is blurry and not blank", () => {
    expect(renderScale(4, { width: 5000, height: 5000 }, 2)).toBeGreaterThan(0);
  });
});

describe("pageTops", () => {
  it("opens with the padding, gaps between pages, and ends with the column height", () => {
    const tops = pageTops([100, 200], PAGE_GAP, COLUMN_PADDING);
    expect(tops[0]).toBe(COLUMN_PADDING);
    expect(tops[1]).toBe(COLUMN_PADDING + 100 + PAGE_GAP);
    // The trailing entry is the total height: no gap after the last page, but
    // the bottom padding.
    expect(tops[2]).toBe(COLUMN_PADDING + 100 + PAGE_GAP + 200 + COLUMN_PADDING);
  });

  it("has no height beyond its padding with no pages", () => {
    expect(pageTops([])).toEqual([COLUMN_PADDING]);
  });
});

describe("pageWindow", () => {
  const heights = Array.from({ length: 300 }, () => 800);

  it("keeps the crossing pages plus one either side", () => {
    // Page 1 spans 16..816, page 2 828..1628. A viewport at the top sees page 1
    // only, so the window is page 1 and its one-page overscan.
    expect(pageWindow(0, 600, heights)).toEqual({ first: 0, last: 2 });
  });

  it("holds a bounded number of canvases however far down the document it is", () => {
    const mid = pageWindow(80_000, 900, heights);
    expect(mid.last - mid.first).toBeLessThanOrEqual(5);
    expect(mid.first).toBeGreaterThan(90);
  });

  it("keeps the nearest page when nothing intersects, rather than dropping every canvas", () => {
    // A viewport with no height is what jsdom reports, and what the frame
    // before the first measurement reports.
    expect(pageWindow(0, 0, heights)).toEqual({ first: 0, last: 2 });
  });

  it("is empty for a document with no pages", () => {
    expect(pageWindow(0, 600, [])).toEqual({ first: 0, last: 0 });
  });
});

describe("clampPage", () => {
  it("holds a page inside the document", () => {
    expect(clampPage(7, 12)).toBe(7);
    expect(clampPage(999, 12)).toBe(12);
    expect(clampPage(0, 12)).toBe(1);
    expect(clampPage(-3, 12)).toBe(1);
  });

  it("answers 1 for a page that is not a number, and for an empty document", () => {
    expect(clampPage(NaN, 12)).toBe(1);
    expect(clampPage(3, 0)).toBe(1);
  });
});

describe("scrollTopFor and placeAt", () => {
  const heights = [800, 400, 800];

  it("puts a page's top edge at the top of the viewport", () => {
    expect(scrollTopFor(1, heights)).toBe(COLUMN_PADDING);
    expect(scrollTopFor(2, heights)).toBe(COLUMN_PADDING + 800 + PAGE_GAP);
  });

  it("clamps a page the document does not have", () => {
    expect(scrollTopFor(99, heights)).toBe(scrollTopFor(3, heights));
  });

  it("round-trips a reading position through a scroll offset", () => {
    const top = scrollTopFor(2, heights, 0.25);
    expect(placeAt(top, 0, heights)).toEqual({ page: 2, offset: 0.25 });
  });

  it("names the page a third of the way down, not the sliver at the very top", () => {
    // Page 1 ends at 816 and page 2 starts at 828. With a 900-tall viewport
    // scrolled to 700, page 1 is a 116px sliver at the top and page 2 fills the
    // rest: the reader is on page 2, and the probe at 700 + 300 says so.
    expect(placeAt(700, 900, heights).page).toBe(2);
    // The same scroll with no measured viewport has nothing to probe with and
    // falls back to the page at the top edge.
    expect(placeAt(700, 0, heights).page).toBe(1);
  });

  it("lets the offset go negative, because that page can start below the top", () => {
    const place = placeAt(700, 900, heights);
    expect(place.offset).toBeLessThan(0);
    // Still exact: the offset is what puts the scroll back where it was.
    expect(scrollTopFor(place.page, heights, place.offset)).toBeCloseTo(700, 6);
  });

  it("remembers a position as a fraction, so a re-layout lands on the same place", () => {
    const wide = [1600, 800, 1600];
    const place = placeAt(scrollTopFor(3, heights, 0.5), 0, heights);
    // The same fraction of the same page, at twice the scale.
    expect(scrollTopFor(place.page, wide, place.offset)).toBe(
      COLUMN_PADDING + 1600 + PAGE_GAP + 800 + PAGE_GAP + 800,
    );
  });

  it("answers the top of an empty document", () => {
    expect(scrollTopFor(3, [])).toBe(0);
    expect(placeAt(500, 900, [])).toEqual({ page: 1, offset: 0 });
  });
});

describe("zoom", () => {
  const LETTER_VIEWPORT = { width: 612 + COLUMN_PADDING * 2, height: 792 + COLUMN_PADDING * 2 };

  it("reads actual size as 96/72, not 1", () => {
    // A PDF point is 1/72 inch and a CSS pixel 1/96, so a page at the size it
    // would print is a third larger than a naive scale of 1.
    expect(scaleFor("actual", LETTER_VIEWPORT, LETTER)).toBe(CSS_PER_PT);
    expect(percentOf(CSS_PER_PT)).toBe(100);
    expect(percentOf(1)).toBe(75);
  });

  it("fits the width, and fits the page to whichever side runs out first", () => {
    expect(scaleFor("fitWidth", LETTER_VIEWPORT, LETTER)).toBe(1);
    // A viewport as wide but half as tall: the height is what binds.
    const squat = { width: LETTER_VIEWPORT.width, height: 396 + COLUMN_PADDING * 2 };
    expect(scaleFor("fitPage", squat, LETTER)).toBe(0.5);
    expect(scaleFor("fitWidth", squat, LETTER)).toBe(1);
  });

  it("falls back to fit-width for a viewport with no measured height", () => {
    expect(fitPageScale(LETTER_VIEWPORT.width, 0, LETTER)).toBe(
      fitWidthScale(LETTER_VIEWPORT.width, LETTER),
    );
  });

  it("takes a percentage as a percentage of actual size", () => {
    expect(scaleFor(200, LETTER_VIEWPORT, LETTER)).toBe(CSS_PER_PT * 2);
    expect(percentOf(scaleFor(150, LETTER_VIEWPORT, LETTER))).toBe(150);
  });

  it("clamps a percentage rather than letting it out of range", () => {
    expect(clampPercent(1)).toBe(MIN_PERCENT);
    expect(clampPercent(9000)).toBe(MAX_PERCENT);
    expect(clampPercent(NaN)).toBe(100);
    expect(percentOf(scaleFor(9000, LETTER_VIEWPORT, LETTER))).toBe(MAX_PERCENT);
  });
});

describe("parsePercent", () => {
  it("takes a number, with or without its sign", () => {
    expect(parsePercent("150")).toBe(150);
    expect(parsePercent(" 150 % ")).toBe(150);
    expect(parsePercent("112.5")).toBe(113);
  });

  it("clamps what it takes, rounding first", () => {
    // 12.5 rounds to 13 and then clamps up, which is why the round is inside.
    expect(parsePercent("12.5")).toBe(MIN_PERCENT);
    expect(parsePercent("5")).toBe(MIN_PERCENT);
    expect(parsePercent("10000")).toBe(MAX_PERCENT);
  });

  it("rejects anything that is not a number, rather than reading it as zero", () => {
    for (const bad of ["", "  ", "abc", "1e3", "-50", "12%%", "1,5", "Infinity"]) {
      expect(parsePercent(bad)).toBeNull();
    }
  });
});

describe("zoomStep", () => {
  it("moves between round stops", () => {
    expect(zoomStep(100, 1)).toBe(125);
    expect(zoomStep(100, -1)).toBe(75);
  });

  it("lands on a stop from between two", () => {
    expect(zoomStep(110, 1)).toBe(125);
    expect(zoomStep(110, -1)).toBe(100);
  });

  it("stops at the bounds rather than wrapping", () => {
    expect(zoomStep(MAX_PERCENT, 1)).toBe(MAX_PERCENT);
    expect(zoomStep(MIN_PERCENT, -1)).toBe(MIN_PERCENT);
  });
});
