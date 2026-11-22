import { relative } from "node:path";

export default class SolidDiagnosticsReporter {
  onTestRunEnd(modules) {
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
