// The gutter you click to mark a line, and the field that keeps those marks
// pointing at the right line while you type.
//
// The marks are *stored* by line number (that is what survives a restart) but
// *held* here as document positions in a `RangeSet`, which CodeMirror maps
// through every change for free. Without that, inserting ten lines at the top of
// a file would leave every mark below sitting ten lines above the code it was
// put on, and nothing would ever put them back.
//
// So the two directions happen at different moments and never fight: the store
// seeds the field when a buffer is opened or the pane's copy changes, and the
// field reports back whenever an edit moved a mark. `bookmarks.ts` owns the
// shape and the rules; this file owns the positions and the click.
//
// Editor-side on purpose: this imports CodeMirror, so it sits behind the lazy
// editor boundary and must never be imported from the eager side.

import { gutter, GutterMarker, EditorView } from "@codemirror/view";
import { StateField, StateEffect, RangeSet, type Range, type EditorState } from "@codemirror/state";
import type { Bookmark } from "../../utils/bookmarks";

/** Styled in `App.css`, beside the diff and blame gutter classes, for the same
 *  reason: these end up in CodeMirror's own DOM, outside any scoped tree. */
export const BOOKMARK_GUTTER_CLASS = "cm-bookmark-gutter";
export const BOOKMARK_MARKER_CLASS = "cm-bookmark";
/** The faint dot on an unmarked line, shown only while the column is hovered.
 *  Without it the gutter is an empty strip: there is nothing to hover, so
 *  nothing tells you a click there would do anything. */
export const BOOKMARK_HINT_CLASS = "cm-bookmark-hint";

/** A mark carries its label, so an edit that moves it moves the name with it.
 *  Storing labels beside the positions rather than in a second map is what makes
 *  that free: `RangeSet.map` keeps each value with the position it belongs to. */
class BookmarkMarker extends GutterMarker {
  constructor(readonly label?: string) {
    super();
  }
  readonly elementClass = BOOKMARK_MARKER_CLASS;
  toDOM() {
    const dot = document.createElement("span");
    dot.textContent = "●";
    if (this.label) dot.title = this.label;
    return dot;
  }
  eq(other: BookmarkMarker) {
    return other.label === this.label;
  }
}

/** Holds the column open before anything is marked, so marking the first line in
 *  a file does not shove the whole document sideways. Deliberately *not* a
 *  `BookmarkMarker`: CodeMirror renders the spacer as a real (hidden) element,
 *  and one carrying the marker class would be a mark on no line at all. */
class SpacerMarker extends GutterMarker {
  toDOM() {
    const dot = document.createElement("span");
    dot.textContent = "●";
    return dot;
  }
}

/** The hover hint, on every line that is not marked. */
class HintMarker extends GutterMarker {
  readonly elementClass = BOOKMARK_HINT_CLASS;
  toDOM() {
    const dot = document.createElement("span");
    dot.textContent = "●";
    return dot;
  }
}
const HINT = new HintMarker();

const setBookmarks = StateEffect.define<RangeSet<GutterMarker>>();

const bookmarkField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    // Mapped first, so an effect arriving in the same transaction as an edit
    // replaces an already-current set rather than a stale one.
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBookmarks)) value = e.value;
    return value;
  },
});

function buildMarkers(state: EditorState, marks: readonly Bookmark[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  const seen = new Set<number>();
  for (const mark of marks) {
    // A mark past the end of the file is one the file was edited out from under
    // (a revert, a checkout). Dropped rather than clamped to the last line,
    // which would silently move it somewhere nobody chose.
    if (mark.line < 1 || mark.line > state.doc.lines || seen.has(mark.line)) continue;
    seen.add(mark.line);
    ranges.push(new BookmarkMarker(mark.label).range(state.doc.line(mark.line).from));
  }
  return RangeSet.of(ranges, true);
}

/** The marks a state currently holds, as line numbers and labels. This is what
 *  goes back to the store after an edit has moved them. */
export function bookmarksIn(state: EditorState): Bookmark[] {
  const out: Bookmark[] = [];
  const seen = new Set<number>();
  const iter = state.field(bookmarkField, false)?.iter();
  for (; iter?.value; iter.next()) {
    const line = state.doc.lineAt(iter.from).number;
    // Two marks can be squeezed onto one line by deleting what was between
    // them. They are one mark now; the first one's label is the one that
    // described the line that survived.
    if (seen.has(line)) continue;
    seen.add(line);
    const label = (iter.value as BookmarkMarker).label;
    out.push(label ? { line, label } : { line });
  }
  return out;
}

/** The effect that installs a file's marks on a state. Mirrors `blameEffect`,
 *  and for the same reason: a caller holding only a state (the mapping tests,
 *  which need no DOM) applies it to a transaction directly. */
export function bookmarkEffect(state: EditorState, marks: readonly Bookmark[]) {
  return setBookmarks.of(buildMarkers(state, marks));
}

/** Replace the marks for the view's current buffer. */
export function setBookmarkMarkers(view: EditorView, marks: readonly Bookmark[]): void {
  view.dispatch({ effects: bookmarkEffect(view.state, marks) });
}

/**
 * The bookmark gutter, its field, and the reporting of moved marks.
 *
 * `onToggle` is the click: a gutter click is a toggle rather than an add,
 * because the same target has to be able to undo itself. There is nowhere else
 * to click to remove one.
 *
 * `onMoved` fires only when an edit actually changed which lines are marked, not
 * on every keystroke: the pane writes what it is told straight into a persisted
 * store, and a write per character typed would be a write per character typed.
 * It carries the buffer's line count, because what it reports is *everything the
 * buffer knows about* and the pane has to be able to tell that from
 * "everything there is": a mark past the end of a file that shrank under it is
 * one this buffer cannot hold, not one the reader removed.
 */
export function bookmarkGutter(handlers: {
  onToggle: (line: number) => void;
  onMoved: (marks: Bookmark[], docLines: number) => void;
}) {
  return [
    bookmarkField,
    gutter({
      class: BOOKMARK_GUTTER_CLASS,
      markers: (view) => view.state.field(bookmarkField),
      // A hint on every line that has no mark, so the column has something to
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
      const before = bookmarksIn(u.startState);
      const after = bookmarksIn(u.state);
      if (before.length === after.length && before.every((b, i) => b.line === after[i].line)) return;
      handlers.onMoved(after, u.state.doc.lines);
    }),
  ];
}
