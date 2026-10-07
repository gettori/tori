import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from "pdfjs-dist";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import QuoteSelection, { selectionWithin } from "../../components/QuoteSelection/QuoteSelection";
import { loadPdf, pdfFailureMessage, pdfTextLayer, pdfView, setPdfView } from "./pdfDocument";
import {
  clampPage,
  clampPercent,
  pageTops,
  pageWindow,
  percentOf,
  placeAt,
  renderScale,
  scaleFor,
  scrollTopFor,
  type PageSize,
} from "./pdfLayout";
import styles from "./PdfView.module.css";
import { mod, otherMod } from "../../utils/platform";

/** How long a resize drag has to settle before the visible pages are rasterised
 *  again. The column reflows immediately either way; only the repaint waits, so
 *  a drag stretches the canvases it already has instead of re-rendering per
 *  frame. */
const REPAINT_SETTLE_MS = 120;

/** Read-only view for a PDF opened from the tree, an attachment chip or
 *  `OPEN_IN_EDITOR` - CodeEditor reads a file as UTF-8, which is not what a PDF
 *  is, so a PDF tab never goes through it (the same reason `ImageView` exists).
 *
 *  The parsed document is not held here but in `pdfDocument.ts`, keyed by path:
 *  this component is created and destroyed with its pane's tab, and a reading
 *  position that died with a tab switch would be worse than none. */
export default function PdfView(props: {
  path: string;
  goto?: { path: string; line: number; nonce: number } | null;
  /** Selected text on its way to the agent, with the pages it spans. The view
   *  knows which pages the selection touches and nothing about sessions, so the
   *  send itself belongs to `Editor.tsx`. */
  onQuote?: (text: string, firstPage: number, lastPage: number) => void;
}) {
  // Keyed, so switching from one PDF tab to another in the same pane rebuilds
  // the view rather than leaving a component holding the previous document's
  // page sizes, render tasks and scroll position.
  return (
    <Show when={props.path} keyed>
      {(path) => <PdfDocumentView path={path} goto={props.goto} onQuote={props.onQuote} />}
    </Show>
  );
}

function PdfDocumentView(props: {
  path: string;
  goto?: { path: string; line: number; nonce: number } | null;
  onQuote?: (text: string, firstPage: number, lastPage: number) => void;
}) {
  const [doc, setDoc] = createSignal<PDFDocumentProxy | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  // One entry per page, null until that page has been asked for its own size.
  // Page 1's size stands in for the rest so the column has honest-enough
  // placeholders from the first frame; most PDFs are one size throughout.
  const [sizes, setSizes] = createSignal<(PageSize | null)[]>([]);
  const [width, setWidth] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);

  let scroller: HTMLDivElement | undefined;
  let placed = false;
  let appliedNonce: number | null = null;
  let appliedJump: number | null = null;
  /** Where the next scale change has to land, when it is not the default probe
   *  line: a pinch keeps the place under the pointer instead. */
  let anchor: { page: number; offset: number; viewportY: number } | null = null;
  /** The place under the probe line, recorded under the heights that were on
   *  screen at the time, since a scale change cannot work it out afterwards. */
  let probeAnchor = { page: 1, offset: 0 };
  const measuring = new Set<number>();
  const tasks = new Map<number, RenderTask>();

  const firstSize = () => sizes()[0] ?? null;
  const sizeOf = (i: number) => sizes()[i] ?? firstSize();
  const scale = createMemo(() => {
    const f = firstSize();
    return f ? scaleFor(pdfView(props.path).zoom, { width: width(), height: height() }, f) : 1;
  });
  const heights = createMemo(() => sizes().map((_, i) => (sizeOf(i)?.height ?? 0) * scale()));
  const tops = createMemo(() => pageTops(heights()));
  const columnHeight = () => tops()[tops().length - 1];
  // On the count rather than on `sizes()` itself: measuring one page replaces
  // that array, and rebuilding a 300-entry index list each time would be work
  // for a `<For>` that reconciles it back to no change at all.
  const pageCount = createMemo(() => sizes().length);
  const pageIndexes = createMemo(() => Array.from({ length: pageCount() }, (_, i) => i));
  const win = createMemo(() => pageWindow(scrollTop(), height(), heights()));

  /** The pages a standing selection reaches across, as a half-open range of
   *  indexes, or null when there is no selection in this view. */
  const [selected, setSelected] = createSignal<{ first: number; last: number } | null>(null);

  /** Text layers still streaming their page's words. A quote waits on these;
   *  see `quote` for why. Not a signal: nothing renders from it. */
  const streaming = new Set<Promise<unknown>>();

  /**
   * Whether a page needs selectable text: it is being drawn, or the selection
   * reaches it. Two ranges rather than one spanning both, because a selection on
   * page 3 read from page 300 would otherwise mount every page between them.
   *
   * Both halves matter. Evicting the page holding an end of the selection
   * deletes the node the range is anchored to, and a range whose boundary is
   * removed collapses - so scrolling from page 3 to page 6 would silently lose
   * the selection on the way. Evicting a page *between* the ends leaves the
   * range intact but empties it: `toString()` walks the DOM as it is now, so the
   * quote would come back missing its middle.
   */
  function needsText(i: number): boolean {
    const w = win();
    if (i >= w.first && i < w.last) return true;
    const s = selected();
    return !!s && i >= s.first && i < s.last;
  }

  // The scale canvases are actually rasterised at, which trails the layout
  // scale through a resize. `createMemo` above dedupes by value, so this only
  // restarts the timer when the width really moved.
  const [paintScale, setPaintScale] = createSignal(1);
  createEffect(
    on(scale, (s, prev) => {
      if (prev === undefined) return setPaintScale(s);
      const t = setTimeout(() => setPaintScale(s), REPAINT_SETTLE_MS);
      onCleanup(() => clearTimeout(t));
    }),
  );

  onMount(() => {
    let live = true;
    onCleanup(() => {
      live = false;
      for (const task of tasks.values()) task.cancel();
      tasks.clear();
    });

    loadPdf(props.path).then(
      async (d) => {
        const page = await d.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        if (!live) return;
        const first = { width: vp.width, height: vp.height };
        setSizes(Array.from({ length: d.numPages }, (_, i) => (i === 0 ? first : null)));
        setDoc(d);
      },
      (err) => {
        if (live) setFailure(pdfFailureMessage(props.path, err));
      },
    );

    const el = scroller;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    };
    const onScroll = () => record(el.scrollTop, el.clientHeight);
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => el.removeEventListener("scroll", onScroll));
    installPinch(el);
    // On the document, because that is where a selection lives: the anchor and
    // the focus can be in two different pages, and there is no element between
    // them but this view's own scroller.
    document.addEventListener("selectionchange", readSelection);
    onCleanup(() => document.removeEventListener("selectionchange", readSelection));
    // Focusable, so the chord below is the focused pane's and the browser's own
    // routing is what says which pane that is. Set here rather than passed to
    // `OverlayScroll`, whose extra props land on the frame and not on the
    // scroller. Arrow-key scrolling comes with it, which a reader wants anyway.
    el.tabIndex = 0;
    el.addEventListener("keydown", onQuoteKey);
    onCleanup(() => el.removeEventListener("keydown", onQuoteKey));
    // Guarded the way OverlayScroll guards its own: jsdom implements neither
    // ResizeObserver nor layout, so there is nothing to observe and nothing is
    // lost by not observing it.
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    }
  });

  /** A page's own size, asked for as it comes into the window. Until then it
   *  borrows page 1's, so the column's height is a good guess rather than a
   *  measurement - which is the difference between a scrollbar that settles and
   *  one that jumps on every page. */
  async function measurePage(d: PDFDocumentProxy, i: number) {
    if (measuring.has(i)) return;
    measuring.add(i);
    try {
      const vp = (await d.getPage(i + 1)).getViewport({ scale: 1 });
      setSizes((prev) => {
        if (prev[i]) return prev;
        const next = [...prev];
        next[i] = { width: vp.width, height: vp.height };
        return next;
      });
    } catch {
      // A page that will not describe itself keeps page 1's size; there is
      // nothing better to show and nothing for the reader to do about it.
    }
  }

  createEffect(() => {
    const d = doc();
    if (!d) return;
    const { first, last } = win();
    for (let i = first; i < last; i++) if (!sizes()[i]) void measurePage(d, i);
  });

  // An explicit destination beats the remembered one, so this is declared
  // before the restore below and latches `placed` when it fires. Held until the
  // document is loaded, which is what makes a cold open land on the right page
  // rather than at the top; re-applied per nonce, so asking for the same page
  // again after scrolling away scrolls back.
  createEffect(() => {
    const g = props.goto;
    const d = doc();
    if (!d || !g || g.path !== props.path || g.nonce === appliedNonce) return;
    appliedNonce = g.nonce;
    placed = true;
    scrollToPage(clampPage(g.line, d.numPages), 0);
  });

  // The page the toolbar's field asked for, applied per nonce for the same
  // reason `goto` is: typing the page you are already on has to work.
  createEffect(() => {
    const jump = pdfView(props.path).jump;
    const d = doc();
    if (!d || !jump || jump.nonce === appliedJump) return;
    appliedJump = jump.nonce;
    placed = true;
    scrollToPage(clampPage(jump.page, d.numPages), 0);
  });

  // The reading position this path was left at, restored once the column has a
  // real width behind its heights.
  createEffect(() => {
    if (placed || !doc() || !width()) return;
    placed = true;
    const { page, offset } = pdfView(props.path);
    if (page > 1 || offset !== 0) scrollToPage(page, offset);
  });

  // What the toolbar needs and cannot work out: the page count, and what the
  // zoom setting actually resolved to at this pane's width.
  createEffect(() => setPdfView(props.path, { pages: pageCount() }));
  createEffect(() => setPdfView(props.path, { scale: scale() }));

  /**
   * A change of scale rewrites every page's height, so the pixel offset the
   * viewport is sitting at stops naming the place it named a moment ago. Every
   * caller re-anchors through here; the only difference between them is which
   * point they keep still.
   *
   * The default is the line the page number is read from, a third of the way
   * down, and *not* the viewport's top. Anchoring on the top lets the reported
   * page slip, because an offset is a fraction of a page's height while the
   * probe is a fixed distance: a page starting 29% of a page above the fold sits
   * 232px up at 100% and 618px up at 200%, so the probe, still 300px down, ends
   * up on the page before. Keeping the probe still makes the page stable by
   * construction, which is what "zoom in three times and reset" has to mean.
   *
   * `heights()` is already the new scale's by the time this runs, so the place
   * cannot be worked out here: it is recorded by `record` under the heights that
   * were on screen when the reader was looking at it.
   */
  createEffect(
    on(scale, (s, prev) => {
      if (prev === undefined || prev === s || !placed) return;
      const held = anchor ?? { ...probeAnchor, viewportY: height() / 3 };
      anchor = null;
      scrollTo(scrollTopFor(held.page, heights(), held.offset) - held.viewportY);
    }),
  );

  function scrollToPage(page: number, offset: number) {
    setPdfView(props.path, { page, offset });
    scrollTo(scrollTopFor(page, heights(), offset));
  }

  function scrollTo(top: number) {
    const el = scroller;
    if (!el) return;
    el.scrollTop = Math.max(0, top);
    record(el.scrollTop, el.clientHeight);
  }

  /** Where the viewport now is, in the two forms the rest of this needs: the
   *  reading position the store carries, and the place under the probe line
   *  that a scale change re-anchors on. */
  function record(top: number, viewportHeight: number) {
    const hs = heights();
    setScrollTop(top);
    setPdfView(props.path, placeAt(top, viewportHeight, hs));
    probeAnchor = placeAt(top + viewportHeight / 3, 0, hs);
  }

  /**
   * Zoom by a factor, keeping whatever is `viewportY` pixels down the viewport
   * where it is. The scale change lands in the store; the effect above does the
   * scrolling, because that has to happen after the heights have moved.
   *
   * Answers whether it took, which is what lets a caller accumulate: a factor
   * too small to move the rounded percentage does nothing here, and a gesture
   * that treated that as applied would throw the increment away and never zoom
   * at all under a slow pinch.
   */
  function zoomAround(factor: number, viewportY: number): boolean {
    const from = percentOf(scale());
    const percent = clampPercent(percentOf(scale() * factor));
    if (percent === from) return false;
    anchor = { ...placeAt(scrollTop() + viewportY, 0, heights()), viewportY };
    setPdfView(props.path, { zoom: percent });
    return true;
  }

  /**
   * A trackpad pinch, in both the forms a browser reports it.
   *
   * WebKit sends `gesturestart` / `gesturechange` with a cumulative `e.scale`,
   * and the `gesturestart` has to be `preventDefault`ed or WebKit zooms the
   * whole page underneath us. Chromium sends none of those and reports a pinch
   * as a `wheel` with `ctrlKey` set, which is why both are here even though only
   * the first fires in the app today.
   *
   * `Cmd+=` and its pair are deliberately untouched: those are the app's UI
   * scale, and a PDF tab does not get to redefine a window-wide shortcut.
   */
  function installPinch(el: HTMLDivElement) {
    // Read once per gesture rather than per event: the pane cannot move under a
    // pinch, and this is a layout read on every frame of one otherwise.
    let paneTop = 0;
    const yIn = (clientY: number) => clientY - paneTop;
    // The `e.scale` the last applied step was measured from. Not simply the
    // previous event's: a step too small to move the rounded percentage does
    // nothing, and advancing past it would discard the increment, so a slow
    // pinch would never zoom.
    let appliedScale = 1;

    const onGestureStart = (e: Event) => {
      e.preventDefault();
      paneTop = el.getBoundingClientRect().top;
      appliedScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const { scale: total, clientY } = e as Event & { scale: number; clientY: number };
      if (!total) return;
      // `e.scale` is cumulative over the gesture, so the step is the ratio
      // against the last applied one rather than the value itself.
      if (zoomAround(total / appliedScale, yIn(clientY))) appliedScale = total;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      paneTop = el.getBoundingClientRect().top;
      zoomAround(Math.exp(-e.deltaY / 100), yIn(e.clientY));
    };

    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    // Not passive, because a pinch has to be stopped from scrolling, which costs
    // every ordinary wheel event a trip through this handler before the browser
    // will scroll. Gating it on `"ongesturestart" in window` would skip it on
    // WebKit entirely, but a wrong guess there leaves pinch silently doing
    // nothing, and the handler is two lines.
    el.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => {
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("wheel", onWheel);
    });
  }

  function paint(canvas: HTMLCanvasElement, i: number) {
    createEffect(() => {
      const d = doc();
      const size = sizeOf(i);
      const s = paintScale();
      if (!d || !size) return;
      void render(d, canvas, i, s, size);
    });
    onCleanup(() => {
      tasks.get(i)?.cancel();
      tasks.delete(i);
    });
  }

  async function render(d: PDFDocumentProxy, canvas: HTMLCanvasElement, i: number, s: number, size: PageSize) {
    tasks.get(i)?.cancel();
    tasks.delete(i);
    const page = await d.getPage(i + 1);
    const viewport = page.getViewport({ scale: renderScale(s, size, window.devicePixelRatio || 1) });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const task = page.render({ canvas, viewport });
    tasks.set(i, task);
    try {
      await task.promise;
    } catch {
      // Cancelled by a scale change or an unmount, which is the normal end of
      // most renders in a document being scrolled.
    } finally {
      if (tasks.get(i) === task) tasks.delete(i);
    }
  }

  /**
   * The selectable text over a page: pdf.js's own `TextLayer`, transparent
   * absolutely-positioned spans laid over the canvas from the same stream
   * `getTextContent` reads.
   *
   * Built once and then only re-placed. `update` moves the spans it already has
   * to a new scale, where a rebuild would stream the page's text again on every
   * zoom step and - worse - delete the nodes a standing selection is anchored
   * to, collapsing it.
   */
  function layText(container: HTMLDivElement, i: number) {
    let live = true;
    let layer: TextLayer | null = null;
    // `doc()` is the only tracked read in the effect below and it transitions
    // once, so nothing in the dependencies says "build this once". This does.
    let started = false;
    const [laid, setLaid] = createSignal<PDFPageProxy | null>(null);

    createEffect(() => {
      const d = doc();
      if (!d || started) return;
      started = true;
      const done = build(d).catch(() => {});
      streaming.add(done);
      void done.finally(() => streaming.delete(done));
    });

    async function build(d: PDFDocumentProxy) {
      const [Layer, page] = await Promise.all([pdfTextLayer(), d.getPage(i + 1)]);
      if (!live) return;
      layer = new Layer({
        textContentSource: page.streamTextContent(),
        container,
        viewport: page.getViewport({ scale: scale() }),
      });
      setLaid(page);
      // Rejected by `cancel()` below, which is how most of these end in a
      // document being scrolled.
      await layer.render().catch(() => {});
    }

    // Reads both, so a layer that lands after a zoom is placed at the scale on
    // screen rather than the one it was built at. pdf.js ignores an update that
    // does not move the scale, so every other run of this costs nothing.
    createEffect(() => {
      const page = laid();
      const s = scale();
      if (page && layer) layer.update({ viewport: page.getViewport({ scale: s }) });
    });

    onCleanup(() => {
      live = false;
      layer?.cancel();
      layer = null;
    });
  }

  /** The 1-based page a node sits in, or null for a node outside every page. */
  function pageAt(node: Node | null): number | null {
    const el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
    const page = el?.closest("[data-pdf-page]")?.getAttribute("data-pdf-page");
    const n = page ? Number(page) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  /** Which pages the selection covers, once it is one this view owns. Read off
   *  the range rather than off the anchor and focus, which is what puts the two
   *  ends in document order: a selection dragged upwards anchors at the bottom,
   *  and page 6 to page 3 is not a range. */
  function readSelection() {
    const el = scroller;
    const range = el ? selectionWithin(el, document.getSelection()) : null;
    const from = range && pageAt(range.startContainer);
    const to = range && pageAt(range.endContainer);
    if (!from || !to) return setSelected(null);
    setSelected({ first: from - 1, last: to });
  }

  async function quote(text: string) {
    const s = selected();
    if (!s) return;
    // A shift-click at the far end widens the window, and the pages it just
    // reached are still fetching their words. `toString()` walks the DOM as it
    // is now, so a quote read before they land comes back with a hole in it -
    // which is why the text the button already read is re-read here rather than
    // trusted, and kept only as the fallback if the selection has since gone.
    if (streaming.size) {
      await Promise.all(streaming);
      text = document.getSelection()?.toString() || text;
    }
    props.onQuote?.(text, s.first + 1, s.last);
  }

  /** The same send as the Quote button, for a reader whose hands are on the
   *  keyboard. On the scroller rather than on the document, so it is the focused
   *  pane's chord: a selection left standing in a PDF must not answer for a
   *  keystroke typed in the composer. */
  function onQuoteKey(e: KeyboardEvent) {
    if (!mod(e) || !e.shiftKey || otherMod(e) || e.altKey || e.key.toLowerCase() !== "m") return;
    const text = document.getSelection()?.toString();
    if (!selected() || !text) return;
    e.preventDefault();
    void quote(text);
  }

  return (
    <OverlayScroll class={styles.pdfView} viewportRef={(el) => (scroller = el)}>
      <Show
        when={!failure()}
        fallback={
          <p class={styles.failure} role="status">
            {failure()}
          </p>
        }
      >
        {/* Absolutely positioned from `pageTops`, so an unrendered page still
            occupies its true height and the scrollbar means what it says. */}
        <div class={styles.column} style={{ height: `${columnHeight()}px` }}>
          <For each={pageIndexes()}>
            {(i) => (
              <div
                class={styles.page}
                data-pdf-page={i + 1}
                style={{
                  top: `${tops()[i]}px`,
                  width: `${(sizeOf(i)?.width ?? 0) * scale()}px`,
                  height: `${heights()[i]}px`,
                  // What pdf.js sizes the text layer from; see PdfView.module.css.
                  "--total-scale-factor": `${scale()}`,
                }}
              >
                <Show when={i >= win().first && i < win().last}>
                  <canvas class={styles.canvas} ref={(el) => paint(el, i)} />
                </Show>
                {/* Outlives the canvas by as much as the selection needs: a page
                    scrolled away from keeps its words while it holds an end of
                    the selection, even once it has given up its picture. */}
                <Show when={needsText(i)}>
                  <div class={styles.textLayer} ref={(el) => layText(el, i)} />
                </Show>
              </div>
            )}
          </For>
        </div>
        {/* The same button the chat transcript floats by a selection, scoped to
            this view's scroller so a second PDF pane does not draw its own. */}
        <QuoteSelection root={() => scroller} onQuote={quote} />
      </Show>
    </OverlayScroll>
  );
}
