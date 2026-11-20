#!/usr/bin/env node
// The packs repo runs this from a Tori release's source: `tori validate-pack` checks a
// theme's shape in Rust, but legibility is measured only here, by the app's own admit().
// Run: node scripts/check-theme-contrast.mjs <theme.json | folder>...
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { admit } from "../src/theme/admit.ts";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: check-theme-contrast.mjs <theme.json | folder>...");
  process.exit(2);
}

const files = args.flatMap((arg) => {
  const path = resolve(arg);
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(path, name));
});

let failed = 0;
for (const file of files) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`${file}: not JSON: ${err.message}`);
    failed++;
    continue;
  }
  const admission = admit(value, file);
  if (admission.ok) continue;
  failed++;
  for (const problem of admission.problems) console.error(problem);
}

console.log(`${files.length - failed} of ${files.length} themes pass`);
process.exit(failed > 0 ? 1 : 0);
