// The diagnostics store behind the Problems list.
//
// CodeMirror already holds a file's diagnostics inside its EditorState, but
// that is reachable only from the editor view. The Problems panel is a sibling
// surface, so the editor publishes here on every lint change and the panel
// reads back.
//
// Scope is deliberately "open tabs only". The language server publishes for
// whatever it has analysed, which on a monorepo is far more than the user has
// open, and an unbounded store keyed by path would grow all session. Two
// separate limits enforce that: only a file with a live buffer ever gets
// published (the editor drops a path when its tab closes), and any single
// file's list is capped.

// This module must stay free of runtime CodeMirror imports. Editor and
// ProblemsPanel import it eagerly, so any `@codemirror/*` value import here
// pulls the editor's ~1.3 MB dependency graph into the startup chunk and
// defeats the lazy boundary around CodeEditor. The one helper that needs
// CodeMirror lives in `panels/Editor/problemsFromState.ts`.

import { createSignal } from "solid-js";
import { isUnderPath } from "./pathScope";

export type Severity = "error" | "warning" | "info" | "hint";

export type Problem = {
  /** 1-based, matching what the editor and `@file#L<n>` mentions use. */
  line: number;
  /** Last line the diagnostic covers; equals `line` for the common
   *  single-line case, but a TypeScript error can span several. */
  endLine: number;
  column: number;
  severity: Severity;
  message: string;
};

/** Most severe first. Used for ordering and for deciding what a cap keeps. */
const SEVERITY_ORDER: Severity[] = ["error", "warning", "info", "hint"];

export function severityRank(s: Severity): number {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

// A single file with thousands of diagnostics is a broken tsconfig, not
// something a human reads: past this the list is truncated.
export const MAX_PER_FILE = 200;

/** Truncate a file's diagnostics, keeping the most severe rather than simply
 *  the first: a file with 300 warnings before its first error must not hide
 *  the error. Document order is restored afterwards so the list still reads
 *  top-to-bottom. */
export function capDiagnostics(list: Problem[], max = MAX_PER_FILE): Problem[] {
  if (list.length <= max) return list;
  const bySeverity = [...list].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const kept = bySeverity.slice(0, max);
  return kept.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Per-severity counts for a file's badge. */
export function summarize(list: Problem[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const p of list) out[p.severity]++;
  return out;
}

/** Files ordered by worst severity, then by count, then by path, so the file
 *  most worth looking at sits at the top of the Problems list. */
export function orderFiles(entries: [string, Problem[]][]): [string, Problem[]][] {
  const worst = (list: Problem[]) => Math.min(...list.map((p) => severityRank(p.severity)), SEVERITY_ORDER.length);
  return [...entries].sort(
    (a, b) => worst(a[1]) - worst(b[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
}

// ---- store -------------------------------------------------------------

const [diagnostics, setDiagnostics] = createSignal<Record<string, Problem[]>>({});

export { diagnostics };

/** Publish a file's diagnostics, capped. An empty list removes the entry
 *  outright rather than leaving a file with a zero count in the list. */
export function publishDiagnostics(path: string, list: Problem[]) {
  setDiagnostics((prev) => {
    if (!list.length) {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    }
    return { ...prev, [path]: capDiagnostics(list) };
  });
}

/** Drop a file entirely, called when its tab closes. */
export function dropDiagnostics(path: string) {
  setDiagnostics((prev) => {
    if (!(path in prev)) return prev;
    const next = { ...prev };
    delete next[path];
    return next;
  });
}

/** Drop everything. Full teardown only: a project switch keeps the store, so a
 *  warm project's problems are still there when it is switched back to, and the
 *  consumers scope what they show to the selected root. */
export function clearDiagnostics() {
  setDiagnostics({});
}

/** Drop one evicted project's files, called when the warm-root policy stops its
 *  servers: nothing can update or retract those entries any more. */
export function dropDiagnosticsUnder(root: string) {
  setDiagnostics((prev) => {
    const next: Record<string, Problem[]> = {};
    let changed = false;
    for (const [path, list] of Object.entries(prev)) {
      if (path === root || isUnderPath(path, root)) changed = true;
      else next[path] = list;
    }
    return changed ? next : prev;
  });
}

/** What the server would offer to do about one problem, by title. */
export type FixLookup = (path: string, problem: Problem) => Promise<string[]>;

// Registered by the editor while it is mounted, exactly as
// `setWorkspaceSymbolSearch` is and for the same reason: asking a language
// server what it would fix needs the LSP client, importing the client here
// would drag CodeMirror into the startup chunk, and the Problems panel is on
// the eager side of that boundary. So the capability is handed *in* rather than
// reached for.
let lookup: FixLookup | null = null;

/** Let the editor answer "what could be done about this?". Returns an
 *  unregister. Guarded, so a later registration replacing this one is not
 *  cleared by its predecessor's cleanup. */
export function setDiagnosticFixLookup(fn: FixLookup): () => void {
  lookup = fn;
  return () => {
    if (lookup === fn) lookup = null;
  };
}

/**
 * The fixes on offer for one problem, by title. Empty when no editor is
 * mounted, which is the honest answer: no client is running to ask.
 *
 * Never rejects. This runs on the way to composing a message for an agent, and
 * a server that will not answer is a reason to send the diagnostic alone rather
 * than to send nothing.
 */
export function fixesFor(path: string, problem: Problem): Promise<string[]> {
  if (!lookup) return Promise.resolve([]);
  return lookup(path, problem).catch(() => []);
}
