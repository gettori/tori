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

import { createSignal } from "solid-js";
import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";

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

/** Convert a buffer's CodeMirror lint state into Problems.
 *
 *  CodeMirror addresses diagnostics by absolute document offset; the Problems
 *  list, the editor's jump target and the `@file#L<n>` mention all speak
 *  1-based line/column, so the conversion happens once, here.
 */
export function problemsFromState(state: EditorState): Problem[] {
  const list: Problem[] = [];
  forEachDiagnostic(state, (d, from, to) => {
    const line = state.doc.lineAt(from);
    list.push({
      line: line.number,
      endLine: state.doc.lineAt(Math.max(from, to)).number,
      column: from - line.from + 1,
      severity: (d.severity ?? "error") as Severity,
      message: d.message,
    });
  });
  return list;
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

/** Drop everything, called on project switch. */
export function clearDiagnostics() {
  setDiagnostics({});
}
