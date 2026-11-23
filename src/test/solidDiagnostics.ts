import { OBSERVE } from "solid-js";
import { afterAll, afterEach } from "vite-plus/test";
import ledger from "./solidDiagnosticsLedger.json";

type Tally = Record<string, number>;

const tally: Tally = {};
let file: { name: string; meta: { solidDiagnostics?: Tally } } | undefined;

OBSERVE?.diagnostics.subscribe((entry: { code: string }) => {
  tally[entry.code] = (tally[entry.code] ?? 0) + 1;
});

// Task meta is the one channel that crosses from a test worker to the reporter.
afterEach(({ task }) => {
  file = task.file as typeof file;
  file!.meta.solidDiagnostics = tally;
});

afterAll(() => {
  if (!file) return;
  const allowed = (ledger as unknown as Record<string, Tally>)[file.name] ?? {};
  const over = Object.entries(tally)
    .filter(([code, count]) => count > (allowed[code] ?? 0))
    .map(([code, count]) => `${code}: ${count}, ledger allows ${allowed[code] ?? 0}`);
  if (over.length) throw new Error(`Solid diagnostics above the ledger\n${over.join("\n")}`);
});
