import { OBSERVE } from "solid-js";
import { afterEach } from "vite-plus/test";

const tally: Record<string, number> = {};

OBSERVE?.diagnostics.subscribe((entry: { code: string }) => {
  tally[entry.code] = (tally[entry.code] ?? 0) + 1;
});

// Task meta is the one channel that crosses from a test worker to the reporter.
afterEach(({ task }) => {
  (task.file.meta as { solidDiagnostics?: Record<string, number> }).solidDiagnostics = tally;
});
