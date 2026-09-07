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
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker } from "pdfjs-dist";

/** Which paths this subsystem owns. It lives here rather than in `PdfView` so
 *  that `Editor.tsx` can ask the question without importing the view, which is
 *  lazy and pulls the layout code with it. */
export function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

/** Where the reader was: the page the viewport's top is inside (1-based) and
 *  how far down that page it sits, as a fraction of the page's height. */
export type PdfPlace = { page: number; offset: number };

type Held = {
  /** Kept beside the document because the document has no `destroy` of its own
   *  in pdf.js 6: releasing goes through the loading task, which also aborts a
   *  parse still in flight instead of waiting for it to finish first. */
  task: Promise<PDFDocumentLoadingTask>;
  load: Promise<PDFDocumentProxy>;
  place: PdfPlace;
};

const held = new Map<string, Held>();
let loads = 0;

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
  held.set(path, { task, load, place: { page: 1, offset: 0 } });
  return load;
}

/** Drop a document and free the worker-side memory behind it. Safe while the
 *  parse is still in flight: that request is aborted rather than awaited. */
export function releasePdf(path: string): void {
  const entry = held.get(path);
  if (!entry) return;
  held.delete(path);
  void entry.task.then((t) => t.destroy()).catch(() => {});
}

/** Release every document no longer named by an open tab. Driven from the tab
 *  set rather than from `PdfView`'s cleanup, because a tab switch unmounts the
 *  view while the tab - and the reading position - are still there. */
export function releasePdfsExcept(open: Iterable<string>): void {
  const keep = new Set(open);
  for (const path of [...held.keys()]) if (!keep.has(path)) releasePdf(path);
}

export function pdfPlace(path: string): PdfPlace {
  return held.get(path)?.place ?? { page: 1, offset: 0 };
}

export function setPdfPlace(path: string, place: PdfPlace): void {
  const entry = held.get(path);
  if (entry) entry.place = place;
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
    return `${name} is password-protected, and Sway cannot open protected PDFs.`;
  }
  return `${name} could not be opened as a PDF.`;
}
