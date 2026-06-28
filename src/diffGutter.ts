// CM6 gutter marking added/modified/deleted lines from git_diff_file hunks.
// The markers live in a StateField (so they shift as the user types) and are
// replaced wholesale via the setDiff effect whenever a fresh diff arrives.

import { gutter, GutterMarker, type EditorView } from "@codemirror/view";
import { StateField, StateEffect, RangeSet, type Range, type EditorState } from "@codemirror/state";

export type Hunk = { kind: "added" | "modified" | "deleted"; start: number; count: number };

class DiffMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}
const ADDED = new DiffMarker("cm-diff-added");
const MODIFIED = new DiffMarker("cm-diff-modified");
const DELETED = new DiffMarker("cm-diff-deleted");

const setDiff = StateEffect.define<RangeSet<GutterMarker>>();

const diffField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setDiff)) value = e.value;
    return value;
  },
});

function buildMarkers(state: EditorState, hunks: Hunk[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  const lines = state.doc.lines;
  for (const h of hunks) {
    if (h.kind === "deleted") {
      // A pure deletion marks the line it sits after.
      const ln = Math.min(Math.max(h.start, 1), lines);
      ranges.push(DELETED.range(state.doc.line(ln).from));
    } else {
      const marker = h.kind === "added" ? ADDED : MODIFIED;
      for (let i = 0; i < h.count; i++) {
        const ln = h.start + i;
        if (ln >= 1 && ln <= lines) ranges.push(marker.range(state.doc.line(ln).from));
      }
    }
  }
  return RangeSet.of(ranges, true);
}

/** The gutter + its backing state field, added to every editor buffer. */
export function diffGutterExtension() {
  return [
    diffField,
    gutter({
      class: "cm-diff-gutter",
      markers: (view) => view.state.field(diffField),
    }),
  ];
}

/** Replace the gutter markers for the view's current buffer. */
export function setDiffMarkers(view: EditorView, hunks: Hunk[]) {
  view.dispatch({ effects: setDiff.of(buildMarkers(view.state, hunks)) });
}
