import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import { loadPdf, pdfFailureMessage, pdfPlace, setPdfPlace } from "./pdfDocument";
import {
  clampPage,
  fitWidthScale,
  pageTops,
  pageWindow,
  placeAt,
  renderScale,
  scrollTopFor,
  type PageSize,
} from "./pdfLayout";
import styles from "./PdfView.module.css";

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
}) {
  // Keyed, so switching from one PDF tab to another in the same pane rebuilds
  // the view rather than leaving a component holding the previous document's
  // page sizes, render tasks and scroll position.
  return (
    <Show when={props.path} keyed>
      {(path) => <PdfDocumentView path={path} goto={props.goto} />}
    </Show>
  );
}

function PdfDocumentView(props: {
  path: string;
  goto?: { path: string; line: number; nonce: number } | null;
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
  const measuring = new Set<number>();
  const tasks = new Map<number, RenderTask>();

  const firstSize = () => sizes()[0] ?? null;
  const sizeOf = (i: number) => sizes()[i] ?? firstSize();
  const scale = createMemo(() => {
    const f = firstSize();
    return f ? fitWidthScale(width(), f) : 1;
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
    const onScroll = () => {
      setScrollTop(el.scrollTop);
      setPdfPlace(props.path, placeAt(el.scrollTop, heights()));
    };
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    onCleanup(() => el.removeEventListener("scroll", onScroll));
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

  // The reading position this path was left at, restored once the column has a
  // real width behind its heights.
  createEffect(() => {
    if (placed || !doc() || !width()) return;
    placed = true;
    const { page, offset } = pdfPlace(props.path);
    if (page > 1 || offset > 0) scrollToPage(page, offset);
  });

  // A re-fit at a new width rewrites every page's height, so the pixel offset
  // the viewport is sitting at stops naming the place it named a moment ago.
  // Re-anchoring on the remembered page and fraction is what keeps a pane
  // resize (or a pane that had no width at all when its tab opened) from moving
  // the reader to a different page.
  createEffect(
    on(scale, (s, prev) => {
      if (prev === undefined || prev === s || !placed) return;
      const { page, offset } = pdfPlace(props.path);
      scrollToPage(page, offset);
    }),
  );

  function scrollToPage(page: number, offset: number) {
    setPdfPlace(props.path, { page, offset });
    const el = scroller;
    if (!el) return;
    el.scrollTop = scrollTopFor(page, heights(), offset);
    setScrollTop(el.scrollTop);
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

  async function render(
    d: PDFDocumentProxy,
    canvas: HTMLCanvasElement,
    i: number,
    s: number,
    size: PageSize,
  ) {
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
                style={{
                  top: `${tops()[i]}px`,
                  width: `${(sizeOf(i)?.width ?? 0) * scale()}px`,
                  height: `${heights()[i]}px`,
                }}
              >
                <Show when={i >= win().first && i < win().last}>
                  <canvas class={styles.canvas} ref={(el) => paint(el, i)} />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </OverlayScroll>
  );
}
