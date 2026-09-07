import { describe, expect, it } from "vitest";
import {
  COLUMN_PADDING,
  MAX_CANVAS_PIXELS,
  PAGE_GAP,
  clampPage,
  fitWidthScale,
  pageTops,
  pageWindow,
  placeAt,
  renderScale,
  scrollTopFor,
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
    expect(placeAt(top, heights)).toEqual({ page: 2, offset: 0.25 });
  });

  it("remembers a position as a fraction, so a re-layout lands on the same place", () => {
    const wide = [1600, 800, 1600];
    const place = placeAt(scrollTopFor(3, heights, 0.5), heights);
    // The same fraction of the same page, at twice the scale.
    expect(scrollTopFor(place.page, wide, place.offset)).toBe(
      COLUMN_PADDING + 1600 + PAGE_GAP + 800 + PAGE_GAP + 800,
    );
  });

  it("answers the top of an empty document", () => {
    expect(scrollTopFor(3, [])).toBe(0);
    expect(placeAt(500, [])).toEqual({ page: 1, offset: 0 });
  });
});
