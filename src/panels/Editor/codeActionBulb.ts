// The lightbulb after a line the server has something to offer about.
//
// One bulb at a time, on the caret's line, because that is the only line
// anything has been asked about: a bulb on every fixable line in the file would
// mean a `textDocument/codeAction` per line, and tsserver answers one of those
// with a compile.
//
// Drawn inline after the line's text rather than in a gutter: a gutter column
// that appears and disappears as the caret moves shoves the whole document
// sideways each time. The widget is held as a document position, so CodeMirror
// maps it through every edit and the bulb stays on the code it is about.

import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { Facet, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { chordLabel } from "../../utils/platform";

/** Styled in `App.css`: it ends up in CodeMirror's own DOM, outside any scoped tree. */
export const CODE_ACTION_MARKER_CLASS = "cm-code-action";

const SVG_NS = "http://www.w3.org/2000/svg";
// Lucide's lightbulb, drawn by hand: this module sits behind the lazy editor
// edge and builds its DOM without Solid.
const BULB_PATHS = [
  "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
  "M9 18h6",
  "M10 22h4",
];

const bulbClick = Facet.define<(line: number) => void, ((line: number) => void) | null>({
  combine: (fns) => fns[0] ?? null,
});

class BulbWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = CODE_ACTION_MARKER_CLASS;
    el.title = `Code actions available (${chordLabel(["Alt", "\u23ce"])})`;
    el.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    for (const d of BULB_PATHS) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    el.appendChild(svg);
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const line = codeActionLine(view.state);
      if (line !== null) view.state.facet(bulbClick)?.(line);
    });
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

// `side: 1` keeps it after anything typed at the end of the line.
const BULB = Decoration.widget({ widget: new BulbWidget(), side: 1 });

const setBulb = StateEffect.define<number | null>();

const bulbField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // Mapped first, so an effect arriving in the same transaction as an edit
    // replaces an already-current set rather than a stale one.
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setBulb)) value = bulbAt(tr.state, e.value);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function bulbAt(state: EditorState, line: number | null): DecorationSet {
  // Out of range is a real state, not a bug: the offer was made about a
  // document the file has since been edited or reverted out from under.
  if (line === null || line < 1 || line > state.doc.lines) return Decoration.none;
  return Decoration.set([BULB.range(state.doc.line(line).to)]);
}

/** Put the bulb on `line` (1-based), or take it away with null. */
export function setCodeActionLine(view: EditorView, line: number | null): void {
  view.dispatch({ effects: setBulb.of(line) });
}

/** The line the bulb is on, or null. */
export function codeActionLine(state: EditorState): number | null {
  const iter = state.field(bulbField, false)?.iter();
  return iter?.value ? state.doc.lineAt(iter.from).number : null;
}

/** The bulb's field, and what a click on it does. */
export function codeActionBulb(opts: { onClick: (line: number) => void }) {
  return [bulbField, bulbClick.of(opts.onClick)];
}
