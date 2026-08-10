// The gutter you click to set a breakpoint, and the field that keeps it
// pointing at the right line while you type.
//
// Same arrangement as `bookmarkGutter.ts` and for the same reason: breakpoints
// are *stored* as line numbers (that is what survives a restart and what goes
// out in `setBreakpoints`) but *held* here as document positions in a
// `RangeSet`, which CodeMirror maps through every change for free. Without that,
// inserting ten lines at the top of a file would leave every breakpoint below
// sitting ten lines above the code it was set on, and the debugger would stop
// somewhere nobody chose.
//
// The one thing this column has that the bookmark column does not is a state per
// mark. A breakpoint can be waiting for a save, waiting for the adapter to bind
// it, or bound, and those are three different answers to "will this stop?". The
// state rides in the `RangeSet` value alongside the position, so an edit that
// moves a mark moves its state with it.
//
// Editor-side on purpose: this imports CodeMirror, so it sits behind the lazy
// editor boundary and must never be imported from the eager side.

import { gutter, GutterMarker, EditorView } from "@codemirror/view";
import { StateField, StateEffect, RangeSet, type Range, type EditorState } from "@codemirror/state";
import type { BreakpointMark, BreakpointState } from "../../utils/debugBreakpoints";

/** Styled in `App.css`, beside the bookmark gutter classes, for the same
 *  reason: these end up in CodeMirror's own DOM, outside any scoped tree. */
export const BREAKPOINT_GUTTER_CLASS = "cm-breakpoint-gutter";
export const BREAKPOINT_MARKER_CLASS = "cm-breakpoint";
export const BREAKPOINT_BOUND_CLASS = "cm-breakpoint-bound";
export const BREAKPOINT_PENDING_CLASS = "cm-breakpoint-pending";
/** The faint dot on a line with no breakpoint, shown only while the column is
 *  hovered. Without it the gutter is an empty strip: there is nothing to hover,
 *  so nothing tells you a click there would do anything. */
export const BREAKPOINT_HINT_CLASS = "cm-breakpoint-hint";

const TITLE: Record<BreakpointState, string> = {
  pending: "Breakpoint pending: save the file to arm it",
  armed: "Breakpoint set, not yet bound by the debugger",
  bound: "Breakpoint bound",
};

/** A filled dot once the adapter says it bound, hollow until then. The two
 *  hollow states differ in colour rather than shape, because they differ in
 *  *why* nothing has bound: one is waiting on you, the other on the adapter. */
class BreakpointMarker extends GutterMarker {
  readonly elementClass: string;
  constructor(readonly state: BreakpointState) {
    super();
    const extra =
      state === "bound"
        ? BREAKPOINT_BOUND_CLASS
        : state === "pending"
          ? BREAKPOINT_PENDING_CLASS
          : "";
    this.elementClass = extra ? `${BREAKPOINT_MARKER_CLASS} ${extra}` : BREAKPOINT_MARKER_CLASS;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.textContent = this.state === "bound" ? "●" : "○";
    dot.title = TITLE[this.state];
    return dot;
  }
  eq(other: BreakpointMarker) {
    return other.state === this.state;
  }
}

/** Holds the column open before anything is set, so setting the first
 *  breakpoint in a file does not shove the whole document sideways.
 *  Deliberately *not* a `BreakpointMarker`: CodeMirror renders the spacer as a
 *  real (hidden) element, and one carrying the marker class would be a
 *  breakpoint on no line at all. */
class SpacerMarker extends GutterMarker {
  toDOM() {
    const dot = document.createElement("span");
    dot.textContent = "●";
    return dot;
  }
}

/** The hover hint, on every line with no breakpoint. */
class HintMarker extends GutterMarker {
  readonly elementClass = BREAKPOINT_HINT_CLASS;
  toDOM() {
    const dot = document.createElement("span");
    dot.textContent = "●";
    return dot;
  }
}
const HINT = new HintMarker();

const setBreakpointsEffect = StateEffect.define<RangeSet<GutterMarker>>();

const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    // Mapped first, so an effect arriving in the same transaction as an edit
    // replaces an already-current set rather than a stale one.
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBreakpointsEffect)) value = e.value;
    return value;
  },
});

function buildMarkers(state: EditorState, marks: readonly BreakpointMark[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  const seen = new Set<number>();
  for (const mark of marks) {
    // A breakpoint past the end of the file is one the file was edited out from
    // under (a revert, a checkout). Dropped rather than clamped to the last
    // line, which would silently move it somewhere nobody chose.
    if (mark.line < 1 || mark.line > state.doc.lines || seen.has(mark.line)) continue;
    seen.add(mark.line);
    ranges.push(new BreakpointMarker(mark.state).range(state.doc.line(mark.line).from));
  }
  return RangeSet.of(ranges, true);
}

/** The lines a state currently holds a breakpoint on. This is what goes back to
 *  the store after an edit has moved them. */
export function breakpointsIn(state: EditorState): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const iter = state.field(breakpointField, false)?.iter();
  for (; iter?.value; iter.next()) {
    const line = state.doc.lineAt(iter.from).number;
    // Two breakpoints can be squeezed onto one line by deleting what was between
    // them. They are one breakpoint now: the adapter cannot stop twice on a
    // line.
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** The effect that installs a file's breakpoints on a state. Mirrors
 *  `bookmarkEffect`, and for the same reason: a caller holding only a state (the
 *  mapping tests, which need no DOM) applies it to a transaction directly. */
export function breakpointEffect(state: EditorState, marks: readonly BreakpointMark[]) {
  return setBreakpointsEffect.of(buildMarkers(state, marks));
}

/** Replace the breakpoints for the view's current buffer. */
export function setBreakpointMarkers(view: EditorView, marks: readonly BreakpointMark[]): void {
  view.dispatch({ effects: breakpointEffect(view.state, marks) });
}

/**
 * The breakpoint gutter, its field, and the reporting of moved breakpoints.
 *
 * `onToggle` is the click, for `bookmarkGutter`'s reason: the same target has to
 * be able to undo itself.
 *
 * `onMoved` fires only when an edit actually changed which lines are marked, not
 * on every keystroke, and carries the buffer's line count so the pane can tell
 * "everything this buffer knows about" from "everything there is": a breakpoint
 * past the end of a file that shrank under it is one this buffer cannot hold,
 * not one you removed.
 */
export function breakpointGutter(handlers: {
  onToggle: (line: number) => void;
  onMoved: (lines: number[], docLines: number) => void;
}) {
  return [
    breakpointField,
    gutter({
      class: BREAKPOINT_GUTTER_CLASS,
      markers: (view) => view.state.field(breakpointField),
      // A hint on every line with no breakpoint, so the column has something to
      // reveal on hover. `others` is what `markers` already produced for this
      // line, so a marked line is left alone without asking the field twice.
      lineMarker: (_view, _line, others) => (others.length ? null : HINT),
      initialSpacer: () => new SpacerMarker(),
      domEventHandlers: {
        mousedown: (view, block) => {
          handlers.onToggle(view.state.doc.lineAt(block.from).number);
          // Claimed, so the click does not also land in the buffer and move the
          // caret to a line the reader was only marking.
          return true;
        },
      },
    }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const before = breakpointsIn(u.startState);
      const after = breakpointsIn(u.state);
      if (before.length === after.length && before.every((line, i) => line === after[i])) return;
      handlers.onMoved(after, u.state.doc.lines);
    }),
  ];
}
