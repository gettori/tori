import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const TRACED_CORE = fileURLToPath(new URL("./src/utils/tracedCore.ts", import.meta.url));

const PDFJS_ROOT = fileURLToPath(new URL("./node_modules/pdfjs-dist/", import.meta.url));
// The four data directories pdf.js fetches at runtime, in the order they bite:
// wasm decodes JBIG2/JPEG2000 images, standard_fonts backs the base-14 fonts a
// PDF does not embed, cmaps map CJK encodings, iccs hold colour profiles.
const PDFJS_DATA_DIRS = ["wasm", "standard_fonts", "cmaps", "iccs"];
const PDFJS_BASE = "/pdfjs/";

/**
 * Serves pdf.js's runtime data at `/pdfjs/<dir>/`, in the dev server and in the
 * bundle. It fetches these by URL rather than importing them, so they have to
 * exist as files; copying 4 MB of generated data into `public/` would commit it,
 * so this reads them out of node_modules instead.
 */
const pdfjsData = (): Plugin => ({
  name: "sway-pdfjs-data",
  configureServer(server) {
    // Connect strips the mount prefix, so `req.url` is `/cmaps/78-H.bcmap`. The
    // first segment has to name one of the four directories, which is also what
    // keeps a `..` or an absolute path from reaching anything else.
    server.middlewares.use(PDFJS_BASE, (req, res, next) => {
      const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
      if (rel.includes("..") || !PDFJS_DATA_DIRS.includes(rel.split("/")[0])) return next();
      try {
        const body = readFileSync(PDFJS_ROOT + rel);
        res.setHeader("Content-Type", rel.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        res.end(body);
      } catch {
        next();
      }
    });
  },
  generateBundle() {
    for (const dir of PDFJS_DATA_DIRS) {
      for (const name of readdirSync(PDFJS_ROOT + dir)) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs/${dir}/${name}`,
          source: readFileSync(`${PDFJS_ROOT}${dir}/${name}`),
        });
      }
    }
  },
});

/**
 * Points every `@tauri-apps/api/core` import at `src/utils/tracedCore.ts`, so
 * the performance trace can time each invoke. Tauri's own
 * `__TAURI_INTERNALS__.invoke` is a readonly property on a non-configurable
 * global, so it cannot be wrapped at runtime; this is the remaining seam, and
 * it catches the plugin packages too since they import the same module.
 *
 * Production build only. The dev server and the test run keep the real module,
 * so the 300-odd suites that `vi.mock("@tauri-apps/api/core")` go on mocking
 * exactly what they always did.
 */
const traceCoreImports = () => ({
  name: "sway-trace-core",
  enforce: "pre" as const,
  async resolveId(source: string, importer: string | undefined, options: Record<string, unknown>) {
    if (source !== "@tauri-apps/api/core") return null;
    // tracedCore imports the real thing; anyone else gets tracedCore.
    if (importer === TRACED_CORE) return null;
    return (this as any).resolve(TRACED_CORE, importer, { ...options, skipSelf: true });
  },
});

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [solid(), pdfjsData(), ...(command === "build" ? [traceCoreImports()] : [])],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
