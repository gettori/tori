// A parsed PDF belongs to its path, not to the component showing it.
//
// `PdfView` is created and destroyed with its pane's tab, the same as
// `ImageView`, which is fine for an `<img>` and wrong for a document that took a
// second to parse and has a reading position. So the document, and where the
// reader was in it, live here instead: two panes on one file share the same
// parse, switching to a code tab and back shows the same page at the same
// offset, and nothing is re-read. The release is driven from `Editor.tsx`, off
// the open-tab set rather than off a mount, for exactly that reason.

import { convertFileSrc } from "@tauri-apps/api/core";
import { createStore, produce } from "solid-js/store";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker } from "pdfjs-dist";
import type { PdfZoom } from "./pdfLayout";

/** Which paths this subsystem owns. Re-exported rather than defined here: the
 *  composers and the two transports ask the same question to spell a location as
 *  a page, and one predicate is what keeps the viewer and the wire agreeing
 *  about which files are PDFs. */
export { isPdfPath } from "../../utils/pathScope";

/**
 * What the toolbar and the view have to agree about, per path.
 *
 * Reactive, and not just remembered, because the two are different components
 * in different parts of the pane: `PdfToolbar` sits in the breadcrumb bar's
 * trailing cluster and `PdfView` below it, with no ancestor between them that
 * could hold this. Each field has exactly one writer, which is what keeps that
 * from becoming a loop: the toolbar owns `zoom` and `jump`, the view owns
 * `page`, `offset`, `scale` and `pages`.
 */
export type PdfViewState = {
  /** The page the reader is on, 1-based. */
  page: number;
  /** Where the viewport's top sits in that page, as a fraction of its height.
   *  Negative when the page it names starts below the top edge; see `placeAt`. */
  offset: number;
  /** What the reader asked for. */
  zoom: PdfZoom;
  /** What `zoom` resolved to, in CSS px per point. Published by the view, which
   *  is the only side that knows how wide the pane is, so the toolbar can put a
   *  percentage on a fit mode. */
  scale: number;
  /** The document's page count, once it is parsed. */
  pages: number;
  /** A page the toolbar asked to go to. Carries a nonce rather than being
   *  cleared, the same as the editor's `goto`: asking for the page you are
   *  already on has to work, and a field the view writes back into is a loop. */
  jump: { page: number; nonce: number } | null;
};

// Frozen because `pdfView` hands this same object back for every path with no
// document behind it: one stray write through it would be every future
// document's starting state.
const DEFAULT_VIEW: PdfViewState = Object.freeze({
  page: 1,
  offset: 0,
  zoom: "fitWidth",
  scale: 1,
  pages: 0,
  jump: null,
});

type Held = {
  /** Kept beside the document because the document has no `destroy` of its own
   *  in pdf.js 6: releasing goes through the loading task, which also aborts a
   *  parse still in flight instead of waiting for it to finish first. */
  task: Promise<PDFDocumentLoadingTask>;
  load: Promise<PDFDocumentProxy>;
};

const held = new Map<string, Held>();
const [views, setViews] = createStore<Record<string, PdfViewState>>({});
let loads = 0;
let jumps = 0;

/** Thrown when the library itself will not load, which on this app means a
 *  WebKit too old for it rather than anything about the file. A marker: what
 *  actually went wrong is warned about at the point of failure, since nothing
 *  downstream can do anything with it but say the same sentence. */
export class PdfRuntimeError extends Error {}

let runtime: Promise<typeof import("./pdfjsRuntime")> | null = null;

/** The library, the worker script's URL and the data URLs, fetched once per
 *  session and only once a PDF is actually opened. */
function pdfjsRuntime() {
  runtime ??= import("./pdfjsRuntime").then(
    (m) => {
      m.pdfjs.GlobalWorkerOptions.workerSrc = m.workerUrl;
      return m;
    },
    (reason) => {
      // The tab gets one sentence about macOS; this is the only place the real
      // cause is ever visible, so it goes to the console before being dropped.
      console.warn("[pdf] the viewer library would not load", reason);
      // Latched null so a later open retries rather than inheriting a failure
      // that may have been one bad fetch.
      runtime = null;
      throw new PdfRuntimeError("pdfjs-dist failed to load");
    },
  );
  return runtime;
}

/** pdf.js's `TextLayer`, once the library has loaded. The view needs the class
 *  itself and not only a document, and this module is the one that knows how the
 *  library is fetched. */
export async function pdfTextLayer() {
  return (await pdfjsRuntime()).pdfjs.TextLayer;
}

let worker: Promise<PDFWorker> | null = null;

/** One worker for the session, shared by every document. Ours rather than
 *  pdf.js's implicit per-document one, so `destroy()`ing a document does not
 *  take the worker with it - and so the check below has something to look at. */
function sharedWorker() {
  worker ??= (async () => {
    const { pdfjs } = await pdfjsRuntime();
    const w = new pdfjs.PDFWorker();
    await w.promise;
    // `port` is the real Worker when the worker script loaded, and a same-thread
    // loopback port when pdf.js quietly fell back to parsing on the main thread.
    // That fallback is silent and costs a frozen window on every page, so it is
    // reported in every build rather than only in a dev one - which also makes
    // the absence of this line the check that the worker is real. Nothing is
    // logged on the good path.
    if (!(typeof Worker !== "undefined" && w.port instanceof Worker)) {
      console.warn("[pdf] the worker script did not load; pages will render on the main thread");
    }
    return w;
  })();
  return worker;
}

/** The parsed document for `path`, parsing it on the first ask and answering
 *  with the same one after that. */
export function loadPdf(path: string): Promise<PDFDocumentProxy> {
  const existing = held.get(path);
  if (existing) return existing.load;
  loads++;
  const task = (async () => {
    const [{ pdfjs, runtimeUrls }, w] = await Promise.all([pdfjsRuntime(), sharedWorker()]);
    // Through the asset protocol, the way ImageView reads an image: pdf.js
    // treats only http(s) as fetchable, so this goes over XHR in one piece
    // rather than by range. The file is fully in memory before the first page,
    // which is the honest ceiling for the PDFs a coding tool meets.
    //
    // The worker is passed in rather than left to pdf.js, which is also what
    // keeps `task.destroy()` below from taking the session's worker with it.
    return pdfjs.getDocument({ url: convertFileSrc(path), worker: w, ...runtimeUrls });
  })();
  const load = task.then((t) => t.promise);
  // Nothing may be awaiting these yet (a tab opened and closed inside one
  // tick), and an unobserved rejection is reported as an app-level error.
  void task.catch(() => {});
  void load.catch(() => {});
  held.set(path, { task, load });
  setViews(path, { ...DEFAULT_VIEW });
  return load;
}

/** Drop a document and free the worker-side memory behind it. Safe while the
 *  parse is still in flight: that request is aborted rather than awaited. */
export function releasePdf(path: string): void {
  const entry = held.get(path);
  if (!entry) return;
  held.delete(path);
  setViews(produce((all) => void delete all[path]));
  void entry.task.then((t) => t.destroy()).catch(() => {});
}

/** Release every document no longer named by an open tab. Driven from the tab
 *  set rather than from `PdfView`'s cleanup, because a tab switch unmounts the
 *  view while the tab - and the reading position - are still there. */
export function releasePdfsExcept(open: Iterable<string>): void {
  const keep = new Set(open);
  for (const path of [...held.keys()]) if (!keep.has(path)) releasePdf(path);
}

/** This path's shared view state, tracked: a caller reading it inside an effect
 *  re-runs when the other side writes. A path with no document behind it reads
 *  as the defaults rather than as nothing, so a toolbar rendering a tick before
 *  the parse lands still has numbers to show. */
export function pdfView(path: string): PdfViewState {
  return views[path] ?? DEFAULT_VIEW;
}

/** Write the fields this caller owns. Ignored for a path with no document: the
 *  entry is the document's, and one created here would never be released. */
export function setPdfView(path: string, patch: Partial<PdfViewState>): void {
  if (held.has(path)) setViews(path, patch);
}

/** Ask the view to go to a page, from the toolbar's page field. A nonce rather
 *  than a cleared field, so asking twice for the same page works and the view
 *  never has to write back into what the toolbar owns. */
export function jumpToPdfPage(path: string, page: number): void {
  setPdfView(path, { jump: { page, nonce: ++jumps } });
}

/** The paths with a document behind them, and how many parses have been
 *  started this session. Both are how a test says "loaded once, and released". */
export function retainedPdfPaths(): string[] {
  return [...held.keys()];
}

export function pdfLoadCount(): number {
  return loads;
}

/**
 * One sentence for the tab when a PDF will not open, so the pane says what
 * happened rather than going blank. Three cases, because they need three
 * different things from the reader.
 */
export function pdfFailureMessage(path: string, err: unknown): string {
  const name = path.split("/").pop() || path;
  if (err instanceof PdfRuntimeError) {
    return `${name} needs a newer macOS: this version of WebKit cannot run the PDF viewer.`;
  }
  if ((err as { name?: string } | null)?.name === "PasswordException") {
    return `${name} is password-protected, and Tori cannot open protected PDFs.`;
  }
  return `${name} could not be opened as a PDF.`;
}
