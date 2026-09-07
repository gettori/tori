// The only module in the repo that names `pdfjs-dist` statically, and it is
// reached from `pdfDocument.ts` through a dynamic import alone. That is what
// keeps 2.5 MB of library and worker out of the editor chunk: a session that
// never opens a PDF never loads this file. `lazyEditorBoundary.test.ts` fences
// the specifier, so a static import from anywhere eager fails the suite.
//
// The `?url` import is here rather than beside the loader for the same reason:
// Vite only rewrites it in a static import, which would be an eager edge if it
// sat in a module the editor imports directly.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Served by `vite.config.ts`'s `sway-pdfjs-data` plugin. Absolute, so the same
// string resolves under the dev server's http origin and the release build's
// `tauri://` one; pdf.js needs the trailing slash and throws without it.
const DATA_BASE = "/pdfjs/";

export const runtimeUrls = {
  cMapUrl: `${DATA_BASE}cmaps/`,
  standardFontDataUrl: `${DATA_BASE}standard_fonts/`,
  wasmUrl: `${DATA_BASE}wasm/`,
  iccUrl: `${DATA_BASE}iccs/`,
};

export { pdfjs, workerUrl };
