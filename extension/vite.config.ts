import { defineConfig, type Plugin } from "vite-plus";
import solid from "vite-plugin-solid";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const target: string = process.env.TORI_TARGET ?? "chrome";
// Chrome's build without the key, since the store item already fixes the id.
const store = target === "store";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const json = (path: string) => JSON.parse(read(path).toString());

// Chrome takes up to four dot separated numbers, so the prerelease tag goes.
const version = json("../package.json").version.split("-")[0];

const ICONS: Record<string, string> = { "32": "32x32.png", "128": "128x128.png" };

const manifest = (): Plugin => ({
  name: "tori-extension-manifest",
  generateBundle(_, bundle) {
    for (const name of ["picker.js", "pagelog.js", "pagerelay.js", "inspect.js"]) {
      const script = bundle[name];
      if (script?.type === "chunk" && (script.imports.length || script.dynamicImports.length)) {
        this.error(`${name} is injected as a classic script and cannot import ${script.imports.join(", ")}`);
      }
    }
    // These run in the page's own world, where a top level var would be one of the page's globals,
    // or beside the picker, where it would clash with one of the picker's.
    for (const name of ["pagelog.js", "pagerelay.js", "inspect.js"]) {
      const page = bundle[name];
      if (page?.type === "chunk") page.code = `(() => {\n${page.code}\n})();\n`;
    }
    const merged = {
      ...json("./manifests/base.json"),
      ...json(`./manifests/${store ? "chrome" : target}.json`),
      version,
    };
    if (store) delete merged.key;
    this.emitFile({ type: "asset", fileName: "manifest.json", source: JSON.stringify(merged, null, 2) });
    for (const [size, file] of Object.entries(ICONS)) {
      this.emitFile({ type: "asset", fileName: `icons/${size}.png`, source: read(`../src-tauri/icons/${file}`) });
    }
  },
});

export default defineConfig(({ mode }) => {
  if (store && mode === "development") throw new Error("the store build talks to the release host only");
  return {
    plugins: [solid(), manifest()],
    publicDir: false,
    define: {
      __HOST__: JSON.stringify(mode === "development" ? "app.gettori.tori_dev" : "app.gettori.tori"),
    },
    build: {
      outDir: `dist/${target}`,
      emptyOutDir: true,
      rolldownOptions: {
        input: {
          background: "src/background.ts",
          options: "options.html",
          welcome: "welcome.html",
          devtools: "devtools.html",
          panel: "panel.html",
          picker: "src/picker/index.ts",
          pagelog: "src/pagelog.ts",
          pagerelay: "src/pagerelay.ts",
          inspect: "src/inspect.ts",
        },
        output: {
          // The manifest names the worker and the worker names the picker, the page log and the inspect script by a fixed path.
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
});
