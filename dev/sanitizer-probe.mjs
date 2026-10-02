#!/usr/bin/env node
// Run `sanitizeHtml` against script-execution payloads in a real WKWebView.
// vitest runs it in jsdom, whose parser is not WebKit's, and the bypasses this
// exists for only ever fired in the real engine.
//
//   node dev/sanitizer-probe.mjs
//
// Exits 0 when no payload ran, 1 when one did, 2 when the probe itself failed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "tori-sanitizer-probe-"));
const bundle = join(out, "sanitize.js");

function verdict(stdout) {
  try {
    const report = JSON.parse(stdout.trim().split("\n").pop());
    if (report.armed !== true || !Array.isArray(report.hits)) return 2;
    return report.hits.length === 0 ? 0 : 1;
  } catch {
    return 2;
  }
}

try {
  await build({
    entryPoints: [join(root, "src/utils/sanitizeHtml.ts")],
    bundle: true,
    format: "iife",
    globalName: "tori",
    outfile: bundle,
    logLevel: "error",
  });
  const run = spawnSync("swift", [join(root, "dev/sanitizer-probe.swift"), bundle], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  process.stdout.write(run.stdout ?? "");
  // The report decides, not swift's status: a compile error exits 1 as well.
  process.exitCode = verdict(run.stdout ?? "");
} finally {
  rmSync(out, { recursive: true, force: true });
}
