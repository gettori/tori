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

/** CSS pixels per PDF point. A PDF's unit is 1/72 inch and CSS's is 1/96, so
 *  "actual size" - the page at the size it would print - is this and not 1.
 *  Every scale here is CSS pixels per point, so this is also what turns one
 *  into the percentage the toolbar shows. */
export const CSS_PER_PT = 96 / 72;

/** What the percent field accepts, and what the zoom buttons stop at. */
export const MIN_PERCENT = 25;
export const MAX_PERCENT = 400;

/** The stops the zoom buttons move between. A fixed ladder rather than a
 *  multiplier, so the button lands on round numbers a reader recognises and
 *  returns to exactly 100 rather than near it. */
const ZOOM_STOPS = [25, 50, 75, 100, 125, 150, 200, 300, 400];

/** What the reader asked for: a way of fitting the page, or a percentage. */
export type PdfZoom = "fitWidth" | "fitPage" | "actual" | number;

export type PageSize = { width: number; height: number };

/** The scale that makes a page exactly fill the viewport's usable width. */
export function fitWidthScale(viewportWidth: number, page: PageSize, padding = COLUMN_PADDING): number {
  const usable = viewportWidth - padding * 2;
  if (usable <= 0 || page.width <= 0) return 1;
  return usable / page.width;
}

/** The scale that fits a whole page, both ways. Falls back to fit-width for a
 *  viewport with no measured height, which is the only honest answer there. */
export function fitPageScale(
  viewportWidth: number,
  viewportHeight: number,
  page: PageSize,
  padding = COLUMN_PADDING,
): number {
  const usable = viewportHeight - padding * 2;
  if (usable <= 0 || page.height <= 0) return fitWidthScale(viewportWidth, page, padding);
  return Math.min(fitWidthScale(viewportWidth, page, padding), usable / page.height);
}

/** What a zoom setting means for a given viewport and page, in CSS px per pt. */
export function scaleFor(
  zoom: PdfZoom,
  viewport: { width: number; height: number },
  page: PageSize,
  padding = COLUMN_PADDING,
): number {
  if (typeof zoom === "number") return (clampPercent(zoom) / 100) * CSS_PER_PT;
  if (zoom === "actual") return CSS_PER_PT;
  if (zoom === "fitPage") return fitPageScale(viewport.width, viewport.height, page, padding);
  return fitWidthScale(viewport.width, page, padding);
}

/** The percentage a scale reads as. Rounded, because it is shown in a field the
 *  reader can type back into. */
export function percentOf(scale: number): number {
  return Math.round((scale / CSS_PER_PT) * 100);
}

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(Math.max(Math.round(percent), MIN_PERCENT), MAX_PERCENT);
}

/** What the percent field's text means, or null for anything that is not a
 *  number. Null is a rejection, not a zero: the field puts back what it had. */
export function parsePercent(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? clampPercent(value) : null;
}

/** The next stop above or below the current percentage. Answers the bound when
 *  there is nothing further, so a held button stops rather than wrapping. */
export function zoomStep(percent: number, direction: 1 | -1): number {
  const stops = direction === 1 ? ZOOM_STOPS : [...ZOOM_STOPS].reverse();
  return stops.find((s) => (direction === 1 ? s > percent : s < percent)) ?? clampPercent(percent);
}

/**
 * What a page's canvas may actually be rasterised at. The wanted scale is the
 * display scale times the device pixel ratio, so a retina screen gets a sharp
 * page; the ceiling is what stops a 400% zoom on a large page from asking for a
 * canvas the browser will not allocate.
 */
export function renderScale(scale: number, page: PageSize, dpr: number, maxPixels = MAX_CANVAS_PIXELS): number {
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

/**
 * The reading position: which page the reader is on, and where the viewport's
 * top sits inside it as a fraction of its height. Restoring it after a
 * re-layout at a different scale lands on the same place on the page rather
 * than at the same pixel, which is what `scrollTopFor` inverts.
 *
 * "On" a page means the page crossing a third of the way down the viewport, not
 * the one at its very top. A page's last line is still what you are reading
 * when the next page has already come into view, and a toolbar that renumbers
 * the moment a sliver of the next page appears is wrong more often than right.
 * So `offset` is measured from the viewport's top and can be negative, by up to
 * that third: the page it names may start below the top edge.
 */
export function placeAt(
  scrollTop: number,
  viewportHeight: number,
  heights: number[],
  gap = PAGE_GAP,
  padding = COLUMN_PADDING,
): { page: number; offset: number } {
  if (!heights.length) return { page: 1, offset: 0 };
  const tops = pageTops(heights, gap, padding);
  const page = nearestPage(scrollTop + viewportHeight / 3, tops);
  const h = heights[page - 1];
  return { page, offset: h > 0 ? (scrollTop - tops[page - 1]) / h : 0 };
}
