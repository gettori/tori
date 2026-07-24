#!/usr/bin/env node
// The Phase 4 codemod: rewrite every role token in src/ from the old namespace
// to the taxonomy names, using the explicit table in
// src/theme/__baseline__/rename.ts.
//
// One pass, one alternation, longest name first. A naive
// `for (old of names) text.replace(old, new)` cascades: `--border` is a prefix
// of `--border-strong`, so an earlier entry rewrites a later one's target and
// the damage is invisible in a diff that looks plausible.
//
// src/theme/__baseline__/ is excluded on purpose. The frozen token map is keyed
// by the OLD names by construction, and renaming its keys would turn the proof
// that this migration is nominal into a tautology.
//
// Run: node scripts/rename-tokens.mjs --check   (report only, writes nothing)
//      node scripts/rename-tokens.mjs           (apply)
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES } from "../src/theme/roles.ts";
import { RENAME } from "../src/theme/__baseline__/rename.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");
const EXCLUDE = ["src/theme/__baseline__/"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(css|tsx?)$/.test(path)) out.push(path);
  }
  return out;
}

const olds = Object.keys(RENAME);
const news = Object.values(RENAME);

/** One regex over every old name, longest first so `--border-strong` wins over
 *  `--border`, bounded on both sides so no name matches inside a longer one. */
const PATTERN = new RegExp(
  `(?<![\\w-])(${[...olds].sort((a, b) => b.length - a.length).join("|")})(?![\\w-])`,
  "g",
);

/** The table must account for the whole role set, in whichever direction it has
 *  already been applied. Before the flip roles.ts emits the old names, after it
 *  the new ones; both are consistent states, and neither is a silent gap. */
function validate() {
  const problems = [];
  const current = new Set(ROLES.map((r) => r.cssVar));
  const unmappedFrom = [...current].filter((v) => !RENAME[v]);
  const unmappedTo = [...current].filter((v) => !news.includes(v));
  const direction = unmappedFrom.length === 0 ? "pre-flip" : unmappedTo.length === 0 ? "post-flip" : null;

  if (direction === null) {
    problems.push(
      `the table matches roles.ts in neither direction: ${unmappedFrom.length} emitted cssVars ` +
        `have no entry (${unmappedFrom.slice(0, 5).join(", ")}), and ${unmappedTo.length} are ` +
        `not a rename target (${unmappedTo.slice(0, 5).join(", ")})`,
    );
  }

  const dupes = news.filter((v, i) => news.indexOf(v) !== i);
  if (dupes.length > 0) problems.push(`duplicate rename targets: ${[...new Set(dupes)].join(", ")}`);

  const extra = olds.filter((o) => !current.has(o) && !current.has(RENAME[o]));
  if (extra.length > 0) problems.push(`table names roles that no longer exist: ${extra.join(", ")}`);

  return { problems, direction };
}

function main() {
  const check = process.argv.includes("--check");
  const { problems, direction } = validate();

  for (const p of problems) console.error(`  ${p}`);
  if (problems.length > 0) {
    console.error(`\nrename table is inconsistent with roles.ts (${problems.length} problem(s))`);
    process.exit(1);
  }

  const files = walk(SRC).filter((f) => !EXCLUDE.some((e) => relative(ROOT, f).startsWith(e)));
  let sites = 0;
  const touched = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // Counted only where the name actually changes. 28 of the entries map a name
    // to itself, so counting every match would report a few hundred "rewrites"
    // on a re-run that changed nothing, and a number that moves when nothing
    // moved is a number people stop reading.
    let n = 0;
    const next = text.replace(PATTERN, (m) => {
      if (RENAME[m] !== m) n++;
      return RENAME[m];
    });
    if (n === 0) continue;
    sites += n;
    touched.push([relative(ROOT, file), n]);
    if (!check) writeFileSync(file, next);
  }

  console.log(`table: ${olds.length} entries, ${new Set(news).size} distinct targets, ${direction}`);
  for (const [rel, n] of touched.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${rel}`);
  }
  console.log(`${check ? "would rewrite" : "rewrote"} ${sites} site(s) across ${touched.length} file(s)`);
}

main();
