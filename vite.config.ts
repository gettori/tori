import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const TRACED_CORE = fileURLToPath(new URL("./src/utils/tracedCore.ts", import.meta.url));

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
  plugins: [solid(), ...(command === "build" ? [traceCoreImports()] : [])],

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
