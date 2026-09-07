// The arithmetic behind the page column, kept out of the component so it can be
// tested without a document, a canvas or a layout. Everything here is in the
// same two units: a page's intrinsic size is PDF points (what
// `page.getViewport({ scale: 1 })` answers with), and a scale is CSS pixels per
// point, so a page's on-screen size is always `size * scale`.

/** Gap between pages in the column, and the column's own padding, in CSS px. */
export const PAGE_GAP = 12;
export const COLUMN_PADDING = 16;

/** The ceiling pdf.js's own bundled viewer defaults `maxCanvasPixels` to (the
 *  library exports no constant for it), and the reason it has one: a canvas past
 *  roughly 16 million pixels is refused outright by the browser on some
 *  machines, and a refused canvas paints nothing at all. Past it a page is
 *  rasterised at the largest scale that fits and stretched by CSS, so 400% is
 *  blurry rather than blank. */
export const MAX_CANVAS_PIXELS = 2 ** 24;

export type PageSize = { width: number; height: number };

/** The scale that makes a page exactly fill the viewport's usable width. */
export function fitWidthScale(viewportWidth: number, page: PageSize, padding = COLUMN_PADDING): number {
  const usable = viewportWidth - padding * 2;
  if (usable <= 0 || page.width <= 0) return 1;
  return usable / page.width;
}

/**
 * What a page's canvas may actually be rasterised at. The wanted scale is the
 * display scale times the device pixel ratio, so a retina screen gets a sharp
 * page; the ceiling is what stops a 400% zoom on a large page from asking for a
 * canvas the browser will not allocate.
 */
export function renderScale(
  scale: number,
  page: PageSize,
  dpr: number,
  maxPixels = MAX_CANVAS_PIXELS,
): number {
  const wanted = scale * dpr;
  const area = page.width * page.height;
  if (area <= 0) return wanted;
  return area * wanted * wanted <= maxPixels ? wanted : Math.sqrt(maxPixels / area);
}

/** Each page's top edge in the column, in CSS px, followed by the column's own
 *  total height - so `tops.length` is `pages + 1` and the last entry is the
 *  height. One pass, because every other function here needs the same walk. */
export function pageTops(heights: number[], gap = PAGE_GAP, padding = COLUMN_PADDING): number[] {
  const tops = [padding];
  for (const h of heights) tops.push(tops[tops.length - 1] + h + gap);
  // The trailing gap is the bottom padding's job, not a gap's.
  if (heights.length) tops[tops.length - 1] += padding - gap;
  return tops;
}

/**
 * The pages that need a canvas: those crossing the viewport, plus `overscan`
 * either side so scrolling meets a painted page rather than a blank one.
 * Answers a half-open range, and an empty one (`first === last`) for no pages.
 */
export function pageWindow(
  scrollTop: number,
  viewportHeight: number,
  heights: number[],
  overscan = 1,
  gap = PAGE_GAP,
  padding = COLUMN_PADDING,
): { first: number; last: number } {
  if (!heights.length) return { first: 0, last: 0 };
  const tops = pageTops(heights, gap, padding);
  const bottom = scrollTop + viewportHeight;
  let first = -1;
  let last = 0;
  for (let i = 0; i < heights.length; i++) {
    if (tops[i] + heights[i] <= scrollTop || tops[i] >= bottom) continue;
    if (first < 0) first = i;
    last = i + 1;
  }
  // Nothing intersects: a viewport not laid out yet (jsdom, or the frame before
  // the first measure) has zero height, and dropping every canvas there would
  // leave the column blank until something scrolled it.
  if (first < 0) {
    first = nearestPage(scrollTop, tops) - 1;
    last = first + 1;
  }
  return {
    first: Math.max(0, first - overscan),
    last: Math.min(heights.length, last + overscan),
  };
}

/** The 1-based page whose top edge is nearest above `scrollTop`. */
function nearestPage(scrollTop: number, tops: number[]): number {
  let page = 1;
  for (let i = 0; i < tops.length - 1; i++) if (tops[i] <= scrollTop) page = i + 1;
  return page;
}

/** A page number held inside `1..count`, for a `goto` naming a page the
 *  document does not have. An empty document still answers 1. */
export function clampPage(page: number, count: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), Math.max(count, 1));
}

/** Where the viewport has to sit for `page` to start at its top. */
export function scrollTopFor(
  page: number,
  heights: number[],
  offset = 0,
  gap = PAGE_GAP,
  padding = COLUMN_PADDING,
): number {
  if (!heights.length) return 0;
  const i = clampPage(page, heights.length) - 1;
  const tops = pageTops(heights, gap, padding);
  return tops[i] + offset * heights[i];
}

/** The reading position to remember: the page the viewport's top is inside, and
 *  how far down that page it sits as a fraction of the page's height. Restoring
 *  it after a re-layout at a different width lands in the same place on the
 *  page rather than at the same pixel. */
export function placeAt(
  scrollTop: number,
  heights: number[],
  gap = PAGE_GAP,
  padding = COLUMN_PADDING,
): { page: number; offset: number } {
  if (!heights.length) return { page: 1, offset: 0 };
  const tops = pageTops(heights, gap, padding);
  const page = nearestPage(scrollTop, tops);
  const h = heights[page - 1];
  return { page, offset: h > 0 ? Math.min(Math.max((scrollTop - tops[page - 1]) / h, 0), 1) : 0 };
}
