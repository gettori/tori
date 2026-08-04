// Telling a caret jump from caret drift.
//
// The pane's Back/Forward list wants the places you went, not every line the
// caret passed through on the way. What separates the two is small but has
// several ways to be wrong, so it lives here as its own extension rather than
// inside CodeEditor's buffer closure - the same reason `lspCommands.ts` is a
// file: a decision worth testing against a real EditorView.
//
// Editor-side on purpose: this imports CodeMirror, so it sits behind the lazy
// editor boundary and must never be imported from the eager side.
import { EditorView } from "@codemirror/view";
import { isSignificantMove } from "../../utils/jumpList";

/**
 * Report the caret's new line whenever it moved far enough in one step to count
 * as navigation.
 *
 * Three guards, each for a way this would otherwise report a place nobody went:
 *
 * - `docChanged`: typing at the end of a paste moves the caret a long way
 *   without anyone navigating, and a jump list full of edits is a list nobody
 *   can walk back through.
 * - `selectionSet`: only a transaction that actually set the selection counts,
 *   so a diagnostic or a decoration landing is not a move.
 * - `transactions.length`: a tab switch arrives here as a bare state swap with
 *   no transactions, and its start state is a *different file's* document. The
 *   line numbers on either side of that are not comparable, so without this
 *   guard every tab click would report a jump.
 */
export function cursorJumpListener(report: (line: number) => void) {
  return EditorView.updateListener.of((u) => {
    if (u.docChanged || !u.selectionSet || !u.transactions.length) return;
    const from = u.startState.doc.lineAt(u.startState.selection.main.head).number;
    const to = u.state.doc.lineAt(u.state.selection.main.head).number;
    if (isSignificantMove(from, to)) report(to);
  });
}
