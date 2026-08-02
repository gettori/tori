// CM6 blame: an age-shaded stripe in the gutter, and the commit behind the
// cursor's line shown at the end of it.
//
// Built the same way as `diffGutter.ts`, and for the same reason: the markers
// live in a StateField that maps itself through every change, so **typing moves
// the blame with the lines instead of invalidating it**. That is the whole
// position story. A line the user just wrote has no marker at its start, and a
// line with no marker is exactly what "uncommitted" means here, so the local
// uncommitted set is recomputed by CM6's own mapping rather than by re-blaming
// (see the header of `src/utils/blame.ts`).

import { gutter, GutterMarker, ViewPlugin, Decoration, WidgetType, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { StateField, StateEffect, RangeSet, type Range, type EditorState } from "@codemirror/state";
import { ago } from "../../utils/relativeTime";
import { ageBucket, UNCOMMITTED, type Blame, type BlameCommit } from "../../utils/blame";

class BlameMarker extends GutterMarker {
  // A marker labels the content that *follows* it, so when text is inserted at
  // exactly a line's start it has to move past that insertion. The default
  // (side 0, which maps to before an insertion) leaves the marker where it was,
  // and the line the user just typed inherits the blame of the line it pushed
  // down - the one case that makes blame lie rather than merely go missing.
  startSide = 1;
  endSide = 1;
  // A plain field, not a getter: `GutterMarker` declares it as a property, and
  // the age is fixed for the life of a marker anyway (one is built per commit
  // per read of the blame).
  elementClass: string;

  constructor(readonly commit: BlameCommit) {
    super();
    this.elementClass = `cm-blame-age-${ageBucket(commit.time)}`;
  }
}

const setBlame = StateEffect.define<RangeSet<GutterMarker>>();

const blameField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBlame)) value = e.value;
    return value;
  },
});

function buildMarkers(state: EditorState, blame: Blame): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  // One marker object per commit, reused across its lines: a file with a
  // thousand lines and forty commits allocates forty.
  const markers = blame.commits.map((c) => new BlameMarker(c));
  const lines = Math.min(blame.lines.length, state.doc.lines);
  for (let i = 0; i < lines; i++) {
    const marker = markers[blame.lines[i]];
    // An uncommitted line is left bare rather than marked: it is the same
    // "no marker" state a line typed a second ago is in, and giving the two
    // different renderings would be a distinction with no meaning.
    if (!marker || marker.commit.sha === UNCOMMITTED) continue;
    ranges.push(marker.range(state.doc.line(i + 1).from));
  }
  return RangeSet.of(ranges, true);
}

/**
 * The commit behind a line, or null when the line has none: typed since the
 * blame was read, uncommitted on disk, or past the end of what was blamed.
 *
 * Only a marker sitting *exactly* at the line's start counts. That is what
 * keeps a line the user opened up in the middle of an old block from inheriting
 * its neighbour's commit.
 */
export function blameAtLine(state: EditorState, lineNumber: number): BlameCommit | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null;
  // `false`: with blame switched off the field is not installed at all, and
  // asking for a field a state does not have throws.
  const markers = state.field(blameField, false);
  if (!markers) return null;
  const at = state.doc.line(lineNumber).from;
  let found: BlameCommit | null = null;
  markers.between(at, at, (from, _to, marker) => {
    if (from === at && marker instanceof BlameMarker) {
      found = marker.commit;
      return false;
    }
    return undefined;
  });
  return found;
}

/** What the inline widget says. Exported for its own test: this is the sentence
 *  the reader actually reads, and it has to survive an empty summary. */
export function blameLabel(commit: BlameCommit, now?: number): string {
  const when = ago(commit.time, now);
  const who = commit.author || "unknown";
  return commit.summary ? `${who}, ${when} ago · ${commit.summary}` : `${who}, ${when} ago`;
}

class BlameInline extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: BlameInline) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-blame-inline";
    span.textContent = this.text;
    return span;
  }
  // It sits after the line's text and holds no selection of its own; without
  // this a click on it would move the cursor somewhere the user did not point.
  ignoreEvent() {
    return true;
  }
}

/** What the active-line widget comes to for a given state. Exported so the
 *  "switching blame off leaves nothing behind" test can check it without a
 *  rendered view: the plugin below is a thin wrapper around this. */
export function inlineBlameDecorations(state: EditorState): DecorationSet {
  const line = state.doc.lineAt(state.selection.main.head);
  const commit = blameAtLine(state, line.number);
  // Nothing for an uncommitted line: "not committed yet" beside a line you are
  // in the middle of typing is noise, not news.
  if (!commit) return Decoration.none;
  return Decoration.set([
    Decoration.widget({ widget: new BlameInline(blameLabel(commit)), side: 1 }).range(line.to),
  ]);
}

const blameInlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = inlineBlameDecorations(view.state);
    }
    update(u: ViewUpdate) {
      // Selection moves the widget to another line; a doc change moves the line
      // it is on; the effect is a fresh blame arriving.
      if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setBlame)))) {
        this.decorations = inlineBlameDecorations(u.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** The blame gutter, its state field, and the active-line widget. Held in a
 *  compartment by the editor so switching it off removes all three rather than
 *  leaving an empty column behind. */
export function blameExtension() {
  return [
    blameField,
    gutter({
      class: "cm-blame-gutter",
      markers: (view) => view.state.field(blameField),
    }),
    blameInlinePlugin,
  ];
}

/** The effect that installs a blame on a state. `setBlameMarkers` dispatches it
 *  through a view; a caller holding only a state (the position-mapping tests,
 *  which need no DOM) applies it to a transaction directly. */
export function blameEffect(state: EditorState, blame: Blame) {
  return setBlame.of(buildMarkers(state, blame));
}

/** Replace the blame markers for the view's current buffer. */
export function setBlameMarkers(view: EditorView, blame: Blame) {
  view.dispatch({ effects: blameEffect(view.state, blame) });
}
