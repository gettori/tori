// Where the caret is, and whether getting there counted as a jump.
//
// The pane's Back/Forward list wants the places you went, not every line the
// caret passed through on the way; the breadcrumb bar wants the opposite, every
// line, so it can say which symbol holds the caret right now. Both are small
// rules with several ways to be wrong, so they live here as their own extensions
// rather than inside CodeEditor's buffer closure - the same reason
// `lspCommands.ts` is a file: a decision worth testing against a real
// EditorView.
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

/**
 * Report where the caret is, 1-based, whenever it could have moved.
 *
 * The inverse of the rule above: no threshold, because a breadcrumb trail that
 * only followed *jumps* would sit on the symbol you left rather than the one you
 * are in. Drift is exactly what this wants.
 *
 * Two triggers, each a way the caret ends up somewhere new:
 *
 * - `selectionSet`: arrowing, clicking, a search hit landing.
 * - `docChanged`: typing pushes the caret along without setting the selection in
 *   its own right, and typing a newline changes which line it is on.
 *
 * Everything else that reaches an update listener (a scroll, a focus change, a
 * decoration landing) leaves the caret alone and is skipped, so this costs a
 * `lineAt` per keystroke rather than per frame.
 *
 * A tab swap is deliberately *not* one of the triggers: `setState` never reaches
 * an update listener at all, so the buffer being swapped in would report
 * nothing. `CodeEditor.swapTo` reports that arrival itself, beside the other
 * things it tells the pane about the buffer it just put on screen.
 */
export function caretListener(report: (line: number, column: number) => void) {
  return EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    const head = u.state.selection.main.head;
    const line = u.state.doc.lineAt(head);
    report(line.number, head - line.from + 1);
  });
}
