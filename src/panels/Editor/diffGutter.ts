// CM6 gutter marking added/modified/deleted lines from git_diff_file hunks.
// The markers live in a StateField (so they shift as the user types) and are
// replaced wholesale via the setDiff effect whenever a fresh diff arrives.
//
// A mark also answers what the stripe can only hint at: which lines used to be
// there. Clicking one opens a peek in the same `cm-peek*` shell peekView uses.

import {
  gutter,
  GutterMarker,
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSet, type Extension, type Range } from "@codemirror/state";
import { peekTheme } from "./peekView";

export type Hunk = {
  kind: "added" | "modified" | "deleted";
  start: number;
  count: number;
  old_start: number;
  removed: string[];
};

/** On a mark whose peek would have something in it, so the stripe can say so
 *  on hover. Styled in `App.css` beside the colour rules. */
export const PEEKABLE_CLASS = "cm-diff-peekable";

// Only a hunk that removed something: a pure addition would open an empty panel,
// which reads as a bug rather than as an answer.
function peekable(hunk: Hunk): boolean {
  return hunk.removed.length > 0;
}

class DiffMarker extends GutterMarker {
  readonly elementClass: string;

  constructor(readonly hunk: Hunk) {
    super();
    const base = `cm-diff-${hunk.kind}`;
    this.elementClass = peekable(hunk) ? `${base} ${PEEKABLE_CLASS}` : base;
  }
}

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
    // One marker per hunk, shared by its lines: clicking any of them has to
    // reach the same hunk, and identity is what makes the peek a toggle.
    const marker = new DiffMarker(h);
    if (h.kind === "deleted") {
      // A pure deletion marks the line it sits after.
      const ln = Math.min(Math.max(h.start, 1), lines);
      ranges.push(marker.range(state.doc.line(ln).from));
    } else {
      for (let i = 0; i < h.count; i++) {
        const ln = h.start + i;
        if (ln >= 1 && ln <= lines) ranges.push(marker.range(state.doc.line(ln).from));
      }
    }
  }
  return RangeSet.of(ranges, true);
}

/** The open peek: which hunk, and where its first line is now. */
type DiffPeek = { marker: DiffMarker; anchor: number };

const showPeek = StateEffect.define<DiffPeek>();
const hidePeek = StateEffect.define<null>();

const peekField = StateField.define<DiffPeek | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(showPeek)) return e.value;
      if (e.is(hidePeek)) return null;
      // A fresh diff replaces every marker, so the hunk this was opened from no
      // longer exists and the panel would be describing the file before a save.
      if (e.is(setDiff)) return null;
    }
    if (value && tr.docChanged) return { ...value, anchor: tr.changes.mapPos(value.anchor, -1) };
    return value;
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const value = state.field(field);
      if (!value) return Decoration.none;
      // Back to a line start after mapping: an edit can leave the anchor mid
      // line, and a block widget off a line boundary throws.
      const line = state.doc.lineAt(Math.min(value.anchor, state.doc.length));
      return Decoration.set([
        Decoration.widget({ widget: new DiffPeekWidget(value.marker.hunk), block: true, side: -1 }).range(line.from),
      ]);
    }),
});

class DiffPeekWidget extends WidgetType {
  private view: EditorView | null = null;

  constructor(readonly hunk: Hunk) {
    super();
  }

  eq(other: DiffPeekWidget): boolean {
    return other.hunk === this.hunk;
  }

  toDOM(outer: EditorView): HTMLElement {
    const close = () => outer.dispatch({ effects: hidePeek.of(null) });
    const wrap = document.createElement("div");
    wrap.className = "cm-peek";
    // Same reason as peekView's: a block widget sits inside contentDOM, so the
    // outer editor's handlers (vim's among them) are ancestors of this element,
    // and stopping propagation is what keeps Esc from reaching them.
    wrap.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      },
      true,
    );
    wrap.appendChild(this.header(close));

    const body = document.createElement("div");
    body.className = "cm-peek-body";
    body.appendChild(this.source());
    wrap.appendChild(body);
    return wrap;
  }

  private header(closePeek: () => void): HTMLElement {
    const header = document.createElement("div");
    header.className = "cm-peek-header";

    const count = this.hunk.removed.length;
    const title = document.createElement("span");
    title.className = "cm-peek-title";
    title.textContent = `${count} removed line${count === 1 ? "" : "s"}`;
    header.appendChild(title);

    const where = document.createElement("span");
    where.className = "cm-peek-where";
    const last = this.hunk.old_start + count - 1;
    where.textContent = count === 1 ? `was line ${this.hunk.old_start}` : `were lines ${this.hunk.old_start} to ${last}`;
    header.appendChild(where);

    const close = document.createElement("button");
    close.className = "cm-peek-close";
    close.type = "button";
    close.title = "Close (Esc)";
    close.textContent = "×";
    close.onclick = () => closePeek();
    header.appendChild(close);
    return header;
  }

  private source(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-peek-source";
    this.view = new EditorView({
      state: EditorState.create({
        doc: this.hunk.removed.join("\n"),
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          // Numbered from the old file, so the peek can be cited against the
          // version these lines came from rather than against this one.
          lineNumbers({ formatNumber: (n) => String(n + this.hunk.old_start - 1) }),
        ],
      }),
      parent: host,
    });
    return host;
  }

  destroy(): void {
    this.view?.destroy();
    this.view = null;
  }

  // Everything inside belongs to the widget, so the outer editor must not treat
  // a click in the peek as a click in the document.
  ignoreEvent(): boolean {
    return true;
  }
}

function markerAt(state: EditorState, pos: number): DiffMarker | null {
  const markers = state.field(diffField, false);
  if (!markers) return null;
  const at = state.doc.lineAt(pos).from;
  const found: DiffMarker[] = [];
  markers.between(at, at, (from, _to, marker) => {
    if (from === at && marker instanceof DiffMarker) {
      found.push(marker);
      return false;
    }
    return undefined;
  });
  return found[0] ?? null;
}

// Clicking a hunk's last line still anchors the peek above its first, so the
// removed lines sit where they were removed from rather than where the pointer
// was.
function anchorOf(state: EditorState, marker: DiffMarker): number | null {
  const markers = state.field(diffField, false);
  if (!markers) return null;
  const found: number[] = [];
  markers.between(0, state.doc.length, (from, _to, m) => {
    if (m !== marker) return undefined;
    found.push(from);
    return false;
  });
  return found.length ? state.doc.lineAt(found[0]).from : null;
}

/**
 * Open the peek for the hunk marked at `pos`, or close it when that hunk is
 * the one already showing.
 *
 * False when there is nothing to peek, which leaves the click to whoever else
 * wanted it: on the line-number gutter that is most clicks, so an unmarked line
 * must behave exactly as it did before.
 */
export function toggleDiffPeek(view: EditorView, pos: number): boolean {
  const marker = markerAt(view.state, pos);
  if (!marker || !peekable(marker.hunk)) return false;
  if (view.state.field(peekField, false)?.marker === marker) {
    view.dispatch({ effects: hidePeek.of(null) });
    return true;
  }
  const anchor = anchorOf(view.state, marker);
  if (anchor === null) return false;
  view.dispatch({ effects: showPeek.of({ marker, anchor }) });
  return true;
}

/** `lineNumbers` with the peek wired to it. The 3px stripe is too narrow to aim
 *  at, so the number beside it is the real target. */
export function diffLineNumbers(): Extension {
  return lineNumbers({
    domEventHandlers: { mousedown: (view, block) => toggleDiffPeek(view, block.from) },
  });
}

/** The gutter + its backing state field, added to every editor buffer. */
export function diffGutterExtension(): Extension {
  return [
    diffField,
    peekField,
    gutter({
      class: "cm-diff-gutter",
      markers: (view) => view.state.field(diffField),
      domEventHandlers: { mousedown: (view, block) => toggleDiffPeek(view, block.from) },
    }),
    // Ordinary precedence, for peekView's reason: with vim on and the outer
    // editor focused, Esc belongs to vim. Esc from inside the widget is the
    // widget's own capture-phase listener.
    keymap.of([
      {
        key: "Escape",
        run: (view) => {
          if (!view.state.field(peekField, false)) return false;
          view.dispatch({ effects: hidePeek.of(null) });
          return true;
        },
      },
    ]),
    peekTheme,
  ];
}

/** Replace the gutter markers for the view's current buffer. */
export function setDiffMarkers(view: EditorView, hunks: Hunk[]) {
  view.dispatch({ effects: setDiff.of(buildMarkers(view.state, hunks)) });
}
