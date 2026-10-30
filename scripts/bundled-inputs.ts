import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite-plus";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INPUTS_DIR = join(ROOT, "node_modules/.tori/inputs");

// A worker is its own rolldown build with its own module graph, run inside the
// main build, so every instance for one build name adds to the same set and
// only the main one writes it.
const collected = new Map<string, Set<string>>();

const PNPM_DIR = /\/node_modules\/\.pnpm\/((?:@[^@/]+\+)?[^@/]+)@([^_/]+)/;

/**
 * Writes what a build was made from to `node_modules/.tori/inputs/<build>.tsv`
 * for .github/scripts/ships.sh: one `file` (repo-relative), `package`
 * (`name@version`) or `unknown` (an id that is neither) per line. `extra` names
 * what the config reads on its own, relative to its root. Add it to
 * `worker.plugins` as well, or a worker's imports go unlisted.
 */
export function bundledInputs(build: string, extra: string[] = []): Plugin {
  const inputs = collected.get(build) ?? new Set<string>();
  collected.set(build, inputs);
  let worker = false;
  const file = (path: string) => {
    const rel = relative(ROOT, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) inputs.add(`unknown\t${path}`);
    else inputs.add(`file\t${rel}`);
  };
  return {
    name: "tori-bundled-inputs",
    apply: "build",
    configResolved(config) {
      worker = config.isWorker;
      if (worker) return;
      if (config.configFile) file(config.configFile);
      if (config.publicDir) file(config.publicDir);
      const tsconfig = resolve(config.root, "tsconfig.json");
      if (existsSync(tsconfig)) file(tsconfig);
      for (const path of extra) file(resolve(config.root, path));
    },
    buildEnd() {
      for (const id of this.getModuleIds()) {
        if (id.startsWith("\0")) continue;
        const path = id.split("?")[0];
        const pkg = PNPM_DIR.exec(path);
        if (pkg) inputs.add(`package\t${pkg[1].replace("+", "/")}@${pkg[2]}`);
        else if (isAbsolute(path) && !path.includes("/node_modules/")) file(path);
        else inputs.add(`unknown\t${id}`);
      }
    },
    closeBundle() {
      if (worker) return;
      mkdirSync(INPUTS_DIR, { recursive: true });
      writeFileSync(join(INPUTS_DIR, `${build}.tsv`), [...inputs].sort().join("\n") + "\n");
    },
  };
}
