// The lightbulb beside a line the server has something to offer about.
//
// One marker at a time, on the caret's line, because that is the only line
// anything has been asked about: a bulb on every fixable line in the file would
// mean a `textDocument/codeAction` per line, and tsserver answers one of those
// with a compile.
//
// The marker is *held* as a document position in a `RangeSet` rather than as a
// line number, so CodeMirror maps it through every edit for free. That matters
// more here than it looks: the offer is about a range the server was asked
// about, and an edit that moves the code has to move the bulb with it or the
// bulb starts pointing at something else.

import { gutter, GutterMarker, type EditorView } from "@codemirror/view";
import { StateEffect, StateField, RangeSet, type EditorState } from "@codemirror/state";

/** Styled in `App.css`, beside the bookmark and diff gutter classes, for the
 *  same reason: these end up in CodeMirror's own DOM, outside any scoped tree. */
export const CODE_ACTION_GUTTER_CLASS = "cm-code-action-gutter";
export const CODE_ACTION_MARKER_CLASS = "cm-code-action";

class LightbulbMarker extends GutterMarker {
  // A marker labels the content that *follows* it. The default (side 0, which
  // maps to *before* an insertion) leaves it behind when text is inserted at
  // exactly the line's start, so pressing Enter at the head of a fixable line
  // would leave the bulb on the new empty line while the code it belongs to
  // moved down. The same rule the blame gutter needed, and the same failure:
  // the mark stays put and starts describing the wrong line.
  startSide = 1;
  endSide = 1;
  readonly elementClass = CODE_ACTION_MARKER_CLASS;

  toDOM() {
    const bulb = document.createElement("span");
    bulb.textContent = "●";
    bulb.title = "Code actions available (⌥⏎)";
    return bulb;
  }
}

const BULB = new LightbulbMarker();

const setBulb = StateEffect.define<RangeSet<GutterMarker>>();

const bulbField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    // Mapped first, so an effect arriving in the same transaction as an edit
    // replaces an already-current set rather than a stale one.
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBulb)) value = e.value;
    return value;
  },
});

/** Put the bulb on `line` (1-based), or take it away with null. */
export function setCodeActionLine(view: EditorView, line: number | null): void {
  view.dispatch({ effects: setBulb.of(markersFor(view.state, line)) });
}

function markersFor(state: EditorState, line: number | null): RangeSet<GutterMarker> {
  // Out of range is a real state, not a bug: the offer was made about a
  // document the file has since been edited or reverted out from under.
  if (line === null || line < 1 || line > state.doc.lines) return RangeSet.empty;
  return RangeSet.of([BULB.range(state.doc.line(line).from)], true);
}

/** The line the bulb is on, or null. What a click has to answer, and what the
 *  tests read instead of measuring a jsdom element that has no size. */
export function codeActionLine(state: EditorState): number | null {
  const iter = state.field(bulbField, false)?.iter();
  return iter?.value ? state.doc.lineAt(iter.from).number : null;
}

/**
 * The gutter, plus the field that keeps the bulb pointing at the right line.
 *
 * Deliberately no spacer: the bookmark gutter holds its column open so that
 * marking the first line does not shove the document sideways, but this one is
 * transient by nature - it comes and goes as the caret moves - and a column
 * permanently reserved for it would be a stripe of empty space in every buffer,
 * including every buffer no language server has ever looked at.
 */
export function codeActionGutter(opts: { onClick: (line: number) => void }) {
  return [
    bulbField,
    gutter({
      class: CODE_ACTION_GUTTER_CLASS,
      markers: (view) => view.state.field(bulbField),
      domEventHandlers: {
        mousedown: (view, block) => {
          const line = view.state.doc.lineAt(block.from).number;
          if (codeActionLine(view.state) !== line) return false;
          opts.onClick(line);
          return true;
        },
      },
    }),
  ];
}
