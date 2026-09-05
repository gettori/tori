// What a command tab's runner reported, keyed by tab id. A signal beside the tab
// model, never a field on `OpenTerm`: the strip keys by object identity, and
// replacing a tab to record its exit remounts its surface (gotcha: For over items).
import { createSignal } from "solid-js";

export type CommandStatus = "running" | "ok" | "failed";

const [reported, setReported] = createSignal<Record<string, Exclude<CommandStatus, "running">>>({});

/** A tab nothing has reported for is running: a command tab exists to run one. */
export const commandStatus = (id: string): CommandStatus => reported()[id] ?? "running";

/** Record a runner's report. First report wins: a runner reports once by
 *  construction, so a second under the same id is a replay that would re-toast
 *  and could flip a verdict. Returns whether this report was the one recorded. */
export function reportCommandExit(id: string, code: number): boolean {
  if (id in reported()) return false;
  setReported({ ...reported(), [id]: code === 0 ? "ok" : "failed" });
  return true;
}

/** A closed tab leaves nothing behind, or a later tab reusing the id (dedupe
 *  mints ids from what they act on) would inherit a verdict. */
export function dropCommandStatus(id: string): void {
  if (!(id in reported())) return;
  const next = { ...reported() };
  delete next[id];
  setReported(next);
}

/** Test seam, mirroring `resetTerminalTabModel`. */
export function resetCommandStatus(): void {
  setReported({});
}
