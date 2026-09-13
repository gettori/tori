// A conflicted file in the plain editor: git's marker blocks painted where they
// sit, and a strip down the right edge so a conflict below the fold is findable.
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateField, type ChangeSet, type Extension, type Text } from "@codemirror/state";
import type { LineRange } from "../../utils/conflict";
import { parseMarkers, type MarkerConflict } from "../../utils/conflictMarkers";

const PREFIXES = ["<<<<<<<", "|||||||", "=======", ">>>>>>>"];

// With no conflict in the buffer, only an edit that writes a marker line can
// start one, so an ordinary file pays for the lines it touched, not a rescan.
function touchesMarker(doc: Text, changes: ChangeSet): boolean {
  let found = false;
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    for (let n = doc.lineAt(fromB).number, last = doc.lineAt(toB).number; n <= last && !found; n++) {
      found = PREFIXES.some((p) => doc.line(n).text.startsWith(p));
    }
  });
  return found;
}

const band = (cls: string) => Decoration.line({ class: cls });
const START = band("cm-conflict-marker cm-conflict-current-marker");
const CURRENT = band("cm-conflict-current");
const BASE_MARKER = band("cm-conflict-marker cm-conflict-base-marker");
const BASE = band("cm-conflict-base");
const SPLIT = band("cm-conflict-marker cm-conflict-split");
const INCOMING = band("cm-conflict-incoming");
const END = band("cm-conflict-marker cm-conflict-incoming-marker");

function bands(doc: Text, blocks: MarkerConflict[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const paint = (n: number, deco: Decoration) => builder.add(doc.line(n).from, doc.line(n).from, deco);
  const fill = (range: LineRange, deco: Decoration) => {
    for (let n = range.from; n < range.to; n++) paint(n, deco);
  };
  for (const { markers, current, base, incoming } of blocks) {
    paint(markers.start, START);
    fill(current, CURRENT);
    if (base) {
      paint(base.from - 1, BASE_MARKER);
      fill(base, BASE);
    }
    paint(markers.split, SPLIT);
    fill(incoming, INCOMING);
    paint(markers.end, END);
  }
  return builder.finish();
}

export const conflictMarkerField = StateField.define<MarkerConflict[]>({
  create: (state) => parseMarkers(state.doc),
  update(blocks, tr) {
    if (!tr.docChanged || (!blocks.length && !touchesMarker(tr.newDoc, tr.changes))) return blocks;
    return parseMarkers(tr.newDoc);
  },
  provide: (field) => EditorView.decorations.compute([field], (state) => bands(state.doc, state.field(field))),
});

class ConflictRuler {
  readonly dom = document.createElement("div");

  constructor(readonly view: EditorView) {
    this.dom.className = "cm-conflict-overview";
    this.dom.setAttribute("aria-hidden", "true");
    view.dom.appendChild(this.dom);
    this.place();
    this.draw();
  }

  update(update: ViewUpdate) {
    if (update.geometryChanged) this.place();
    if (
      update.heightChanged ||
      update.geometryChanged ||
      update.startState.field(conflictMarkerField, false) !== update.state.field(conflictMarkerField, false)
    ) {
      this.draw();
    }
  }

  draw() {
    const { view } = this;
    const total = view.contentHeight || 1;
    const doc = view.state.doc;
    this.dom.replaceChildren(
      ...(view.state.field(conflictMarkerField, false) ?? []).map(({ markers }) => {
        const top = view.lineBlockAt(doc.line(markers.start).from).top;
        const bottom = view.lineBlockAt(doc.line(markers.end).from).bottom;
        const mark = document.createElement("div");
        mark.className = "cm-conflict-overview-mark";
        mark.style.top = `${(top / total) * 100}%`;
        mark.style.height = `${((bottom - top) / total) * 100}%`;
        return mark;
      }),
    );
  }

  // Level with the scroller alone, so the find and vim panels stay uncovered.
  place() {
    this.view.requestMeasure({
      key: this,
      read: (view) => ({ top: view.scrollDOM.offsetTop, height: view.scrollDOM.offsetHeight }),
      write: ({ top, height }) => {
        this.dom.style.top = `${top}px`;
        this.dom.style.height = `${height}px`;
      },
    });
  }

  destroy() {
    this.dom.remove();
  }
}

export function conflictBands(): Extension {
  return [
    conflictMarkerField,
    ViewPlugin.fromClass(ConflictRuler),
    EditorView.editorAttributes.compute([conflictMarkerField], (state): Record<string, string> =>
      state.field(conflictMarkerField).length ? { class: "cm-conflict-overview-host" } : {},
    ),
  ];
}
