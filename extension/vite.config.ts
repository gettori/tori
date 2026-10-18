import { defineConfig, type Plugin } from "vite-plus";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const target: string = process.env.TORI_TARGET ?? "chrome";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const json = (path: string) => JSON.parse(read(path).toString());

// Chrome takes up to four dot separated numbers, so the prerelease tag goes.
const version = json("../package.json").version.split("-")[0];

const ICONS: Record<string, string> = { "32": "32x32.png", "128": "128x128.png" };

const manifest = (): Plugin => ({
  name: "tori-extension-manifest",
  generateBundle() {
    const merged = { ...json("./manifests/base.json"), ...json(`./manifests/${target}.json`), version };
    this.emitFile({ type: "asset", fileName: "manifest.json", source: JSON.stringify(merged, null, 2) });
    for (const [size, file] of Object.entries(ICONS)) {
      this.emitFile({ type: "asset", fileName: `icons/${size}.png`, source: read(`../src-tauri/icons/${file}`) });
    }
  },
});

export default defineConfig(({ mode }) => ({
  plugins: [solid(), manifest()],
  publicDir: false,
  define: {
    __HOST__: JSON.stringify(mode === "development" ? "app.gettori.tori_dev" : "app.gettori.tori"),
  },
  build: {
    outDir: `dist/${target}`,
    emptyOutDir: true,
    rolldownOptions: {
      input: { background: "src/background.ts", popup: "popup.html" },
      output: {
        // The manifest names the worker by a fixed path.
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
