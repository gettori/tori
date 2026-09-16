// The only module in the repo that names `pdfjs-dist` statically, and it is
// reached from `pdfDocument.ts` through a dynamic import alone. That is what
// keeps 2.5 MB of library and worker out of the editor chunk: a session that
// never opens a PDF never loads this file. `lazyEditorBoundary.test.ts` fences
// the specifier, so a static import from anywhere eager fails the suite.
import * as pdfjs from "pdfjs-dist";

// Served by `vite.config.ts`'s `tori-pdfjs-data` plugin, in the dev server and
// in the bundle. Absolute, so the same string resolves under the dev server's
// http origin and the release build's `tauri://` one; pdf.js needs the trailing
// slash on the directories and throws without it.
//
// The worker is named here rather than imported with `?url` on purpose: `?url`
// puts the file through Vite's dev transform, which prepends an import of
// `/@vite/client`. That throws inside a worker, which has no `document`, and
// pdf.js answers a failed worker by silently parsing on the main thread.
const BASE = "/pdfjs/";

export const workerUrl = `${BASE}pdf.worker.min.mjs`;

export const runtimeUrls = {
  cMapUrl: `${BASE}cmaps/`,
  standardFontDataUrl: `${BASE}standard_fonts/`,
  wasmUrl: `${BASE}wasm/`,
  iccUrl: `${BASE}iccs/`,
};

export { pdfjs };
