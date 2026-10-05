import { defineConfig, type Plugin, lazyPlugins } from "vite-plus";
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
// The worker rides along, under its own name rather than a directory. It must
// reach the browser byte for byte: `?url` would be the obvious way to name it,
// but in dev Vite runs the file through its transform pipeline and prepends an
// `import ... from "/@vite/client"`. A module worker has no `document`, so that
// import throws, pdf.js catches the worker's `error` and quietly falls back to
// parsing on the main thread. Rollup emits it verbatim, so this was a dev-only
// break, which is worse than a consistent one.
const PDFJS_FILES: Record<string, string> = { "pdf.worker.min.mjs": "build/pdf.worker.min.mjs" };
const PDFJS_BASE = "/pdfjs/";

const mimeOf = (name: string) =>
  name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".mjs") ? "text/javascript" : "application/octet-stream";

/** Where a `/pdfjs/` request reads from on disk, or null if it names nothing we
 *  serve. Everything is spelled out, which is also what keeps a `..` or an
 *  absolute path from reaching anything else. */
function pdfjsFile(rel: string): string | null {
  if (rel.includes("..")) return null;
  if (rel in PDFJS_FILES) return PDFJS_ROOT + PDFJS_FILES[rel];
  const [dir, ...rest] = rel.split("/");
  return PDFJS_DATA_DIRS.includes(dir) && rest.length === 1 ? PDFJS_ROOT + rel : null;
}

/**
 * Serves pdf.js's worker and runtime data at `/pdfjs/`, in the dev server and in
 * the bundle, untransformed in both. pdf.js fetches the data by URL rather than
 * importing it, so it has to exist as files; copying 4 MB of generated data into
 * `public/` would commit it, so this reads it out of node_modules instead.
 */
const pdfjsData = (): Plugin => ({
  name: "tori-pdfjs-data",
  configureServer(server) {
    // Connect strips the mount prefix, so `req.url` is `/cmaps/78-H.bcmap`.
    server.middlewares.use(PDFJS_BASE, (req, res, next) => {
      const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
      const file = pdfjsFile(rel);
      if (!file) return next();
      try {
        const body = readFileSync(file);
        res.setHeader("Content-Type", mimeOf(rel));
        res.end(body);
      } catch {
        next();
      }
    });
  },
  generateBundle() {
    const emit = (name: string, file: string) =>
      this.emitFile({ type: "asset", fileName: `pdfjs/${name}`, source: readFileSync(file) });
    for (const [name, file] of Object.entries(PDFJS_FILES)) emit(name, PDFJS_ROOT + file);
    for (const dir of PDFJS_DATA_DIRS) {
      for (const name of readdirSync(PDFJS_ROOT + dir)) emit(`${dir}/${name}`, `${PDFJS_ROOT}${dir}/${name}`);
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
  name: "tori-trace-core",
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
  fmt: {
    printWidth: 120,
    // Markdown is prose (a reflow turned a changelog's "+ is gone" into a list
    // item) and TOML belongs to Cargo; the rest is generated, vendored or
    // captured, and has to stay byte for byte what produced it.
    ignorePatterns: [
      ".wiki/**",
      "**/target/**",
      "**/dist/**",
      "**/*.md",
      "**/*.toml",
      "src-tauri/resources/**",
      "src-tauri/gen/**",
      "src-tauri/vendor/**",
      "mobile/src-tauri/gen/**",
      "dev/fixtures/**",
      "**/*.golden.json",
      "scripts/vs-seti-icon-theme.json",
      "src/seti/mapping.ts",
    ],
  },

  plugins: lazyPlugins(() => [solid(), pdfjsData(), ...(command === "build" ? [traceCoreImports()] : [])]),

  // The syntax worker loads each grammar by dynamic import, and an iife worker
  // cannot split chunks.
  worker: { format: "es" as const },

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
