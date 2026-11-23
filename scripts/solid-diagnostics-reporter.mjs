import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

const LEDGER = "src/test/solidDiagnosticsLedger.json";

function shrinkLedger(modules) {
  const old = JSON.parse(readFileSync(LEDGER, "utf8"));
  const next = {};
  for (const module of modules) {
    const file = relative(process.cwd(), module.moduleId);
    for (const [code, count] of Object.entries(module.meta().solidDiagnostics ?? {})) {
      const kept = Math.min(count, old[file]?.[code] ?? count);
      if (kept > 0) (next[file] ??= {})[code] = kept;
    }
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  // `$dev` is recorded from a live app run, which a test run cannot re-measure.
  writeFileSync(LEDGER, `${JSON.stringify({ $dev: old.$dev, ...sorted }, null, 2)}\n`);
}

export default class SolidDiagnosticsReporter {
  onTestRunEnd(modules) {
    if (process.env.SOLID_DIAGNOSTICS_SHRINK) shrinkLedger(modules);
    const byCode = new Map();
    for (const module of modules) {
      for (const [code, count] of Object.entries(module.meta().solidDiagnostics ?? {})) {
        const row = byCode.get(code) ?? { total: 0, files: [] };
        row.total += count;
        row.files.push([relative(process.cwd(), module.moduleId), count]);
        byCode.set(code, row);
      }
    }
    const lines = [...byCode].sort(([, a], [, b]) => b.total - a.total);
    console.log(`\nSolid diagnostics: ${lines.length} codes across ${modules.length} test files`);
    for (const [code, { total, files }] of lines) {
      console.log(`${code}: ${total}`);
      for (const [file, count] of files.sort((a, b) => b[1] - a[1])) console.log(`  ${count} ${file}`);
    }
  }
}
