// The one diagnostics helper that needs CodeMirror at runtime.
//
// It lives here rather than in `utils/diagnostics` on purpose. That store is
// imported eagerly by Editor and ProblemsPanel, and a runtime `@codemirror/lint`
// import inside it dragged the whole CodeMirror graph (~1.3 MB of source) into
// the startup chunk even though the editor is only mounted once a file opens.
// Keeping this function on the CodeEditor side of the split leaves the store
// CodeMirror-free, so the lazy boundary in Editor.tsx actually holds.

import { forEachDiagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import type { Problem, Severity } from "../../utils/diagnostics";

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
