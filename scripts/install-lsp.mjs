#!/usr/bin/env node
// `npm install` in `src-tauri/resources/lsp`, run from inside it. Under
// `--prefix`, npm 10 on Windows saves the directory it was started in (the
// repo root) as a `file:../../..` dependency and links it into the bundle.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "resources", "lsp");

// `npm` is `npm.cmd` on Windows, which only a shell can start.
const run = spawnSync("npm", ["install"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
process.exit(run.status ?? 1);
