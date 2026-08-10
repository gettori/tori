// The line the program is paused on.
//
// A line decoration rather than a gutter marker, because what it says is "you
// are here", and that is a property of the whole line rather than of a column
// beside it. Held in a `StateField` mapped through changes for the reason the
// breakpoint gutter is: a paused buffer is still editable, and a highlight that
// stayed on line 40 while the code moved to line 50 would be pointing at
// whatever happened to land there.
//
// One line at a time, deliberately. A run can have several paused sessions, and
// highlighting all of their frames at once would put the same colour on lines
// the reader has no reason to connect; the pane's selected frame is the one
// thing that is being looked at.
//
// Editor-side on purpose: this imports CodeMirror, so it sits behind the lazy
// editor boundary and must never be imported from the eager side.

import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, type EditorState } from "@codemirror/state";

/** Styled in `App.css`, beside the debug gutter classes and for the same
 *  reason: it lands in CodeMirror's own DOM, outside any scoped tree. */
export const FRAME_LINE_CLASS = "cm-debug-frame";

const frameMark = Decoration.line({ class: FRAME_LINE_CLASS });

const setFrameLine = StateEffect.define<number | null>();

const frameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // Mapped first, so an effect arriving in the same transaction as an edit
    // replaces an already-current decoration rather than a stale one.
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFrameLine)) continue;
      value = e.value === null ? Decoration.none : build(tr.state, e.value);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function build(state: EditorState, line: number): DecorationSet {
  // A frame past the end of the buffer is one the file was edited out from
  // under. Nothing is drawn rather than clamping to the last line, which would
  // claim the program is somewhere it is not.
  if (line < 1 || line > state.doc.lines) return Decoration.none;
  return Decoration.set([frameMark.range(state.doc.line(line).from)]);
}

/** The effect that puts the highlight on a line, or takes it away with null.
 *  Mirrors `breakpointEffect`, and for the same reason: a caller holding only a
 *  state applies it to a transaction directly. */
export function frameLineEffect(line: number | null) {
  return setFrameLine.of(line);
}

/** Whether a state currently marks a line, and which. Null when it does not. */
export function frameLineIn(state: EditorState): number | null {
  const set = state.field(frameField, false);
  if (!set) return null;
  const iter = set.iter();
  return iter.value ? state.doc.lineAt(iter.from).number : null;
}

/** Put the highlight on this buffer's line, or clear it with null. A no-op when
 *  nothing changed, so continuing through a breakpoint in a file that is not on
 *  screen dispatches nothing. */
export function setFrameLineMarker(view: EditorView, line: number | null): void {
  if (frameLineIn(view.state) === line) return;
  view.dispatch({ effects: frameLineEffect(line) });
}

/** The field and the decorations it provides. A bare field rather than a
 *  factory taking handlers, unlike the two gutters: nothing here is clickable,
 *  so there is nothing for a buffer to close over. */
export const frameHighlight = () => [frameField];
