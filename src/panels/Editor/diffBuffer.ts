// Git's hunks laid over the file they describe: added lines tinted where they
// sit, removed lines drawn as block widgets where they were removed, and the old
// file's numbers in a gutter of their own. Behind the fence.
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import type { Language } from "@codemirror/language";
import { HIGHLIGHT_MAX } from "../Chat/highlight";
import type { DiffHunk } from "../../utils/diffHunks";
import { buildRows, changedRange, type DiffRow } from "../../utils/diffView";
import { overlay } from "../../utils/syntaxRows";
import { tokenLines, type Span } from "./syntaxLines";

type Placed = { firstNew: number; olds: (number | null)[]; deltaAfter: number };

export type DiffBufferState = { hunks: Placed[]; decorations: DecorationSet; widestOld: number };

/** Git's hunks for the document, and the language to colour removed lines in. */
export const setDiffHunks = StateEffect.define<{ hunks: DiffHunk[]; language: Language | null }>();

const addedLine = Decoration.line({ class: "cm-diff-line-added" });
const addedWord = Decoration.mark({ class: "cm-diff-word-added" });

// A guess for a widget not yet drawn; CodeMirror measures the real height once it is.
const ESTIMATED_LINE_HEIGHT = 18;

class RemovedLines extends WidgetType {
  constructor(
    readonly rows: DiffRow[],
    readonly spans: (Span[] | null)[],
  ) {
    super();
  }

  eq(other: RemovedLines): boolean {
    return (
      other.rows.length === this.rows.length &&
      other.rows.every(
        (r, i) => r.text === this.rows[i].text && r.oldLine === this.rows[i].oldLine && !other.spans[i] === !this.spans[i],
      )
    );
  }

  get estimatedHeight(): number {
    return this.rows.length * ESTIMATED_LINE_HEIGHT;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-diff-removed";
    this.rows.forEach((row, i) => {
      const line = document.createElement("div");
      line.className = "cm-diff-removed-line";
      const body = row.text.slice(1);
      const range = row.kind === "del" && row.segs ? changedRange(row.segs) : null;
      const spans = this.spans[i] ?? [{ text: body, cls: null }];
      for (const piece of range ? overlay(spans, range[0], range[1]) : spans) {
        if (!piece.text) continue;
        const span = document.createElement("span");
        if (piece.cls) span.className = piece.cls;
        if ("changed" in piece && piece.changed) span.classList.add("cm-diff-word-removed");
        span.textContent = piece.text;
        line.appendChild(span);
      }
      if (!body) line.appendChild(document.createElement("br"));
      wrap.appendChild(line);
    });
    return wrap;
  }
}

// Parsed as one text, so a removed line keeps the context it was written in.
function oldSpans(rows: DiffRow[], language: Language | null): (Span[] | null)[] | null {
  if (!language) return null;
  const old = rows.filter((r) => r.kind === "del" || r.kind === "context");
  const text = old.map((r) => (r.kind === "context" && !r.text.startsWith(" ") ? r.text : r.text.slice(1))).join("\n");
  if (text.length > HIGHLIGHT_MAX) return null;
  const lines = tokenLines(text, language);
  let at = 0;
  return rows.map((r) => (r.kind === "del" || r.kind === "context" ? (lines[at++] ?? null) : null));
}

function removedAt(doc: Text, before: number, widget: RemovedLines): Range<Decoration> {
  if (before > doc.lines) return Decoration.widget({ widget, block: true, side: 1 }).range(doc.length);
  return Decoration.widget({ widget, block: true, side: -1 }).range(doc.line(Math.max(1, before)).from);
}

function build(doc: Text, input: DiffHunk[], language: Language | null): DiffBufferState {
  const ranges: Range<Decoration>[] = [];
  const hunks: Placed[] = [];
  let widestOld = doc.lines;

  for (const hunk of input) {
    const rows = buildRows(hunk.lines, { old: hunk.oldStart, new: hunk.startLine });
    const spans = oldSpans(rows, language);
    let nextOld = hunk.oldStart;
    // A hunk with nothing left on the new side (`+N,0`) names the line before it.
    let nextNew = rows.some((r) => r.newLine !== null) ? hunk.startLine : hunk.startLine + 1;
    const firstNew = nextNew;
    const olds: (number | null)[] = [];
    let run: { rows: DiffRow[]; spans: (Span[] | null)[] } | null = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind === "meta") continue;
      if (row.kind === "del") {
        run ??= { rows: [], spans: [] };
        run.rows.push(row);
        run.spans.push(spans?.[i] ?? null);
      } else if (run) {
        ranges.push(removedAt(doc, nextNew, new RemovedLines(run.rows, run.spans)));
        run = null;
      }
      if (row.oldLine !== null) {
        nextOld = row.oldLine + 1;
        widestOld = Math.max(widestOld, row.oldLine);
      }
      if (row.newLine === null) continue;
      nextNew = row.newLine + 1;
      olds.push(row.oldLine);
      if (row.kind !== "add" || row.newLine > doc.lines) continue;
      const line = doc.line(row.newLine);
      ranges.push(addedLine.range(line.from));
      const range = row.segs ? changedRange(row.segs) : null;
      const to = range ? Math.min(range[1], line.length) : 0;
      if (range && range[0] < to) ranges.push(addedWord.range(line.from + range[0], line.from + to));
    }
    if (run) ranges.push(removedAt(doc, nextNew, new RemovedLines(run.rows, run.spans)));

    hunks.push({ firstNew, olds, deltaAfter: nextOld - nextNew });
  }

  const last = hunks[hunks.length - 1];
  if (last) widestOld = Math.max(widestOld, doc.lines + last.deltaAfter);
  return { hunks, decorations: Decoration.set(ranges, true), widestOld };
}

export const diffBufferField = StateField.define<DiffBufferState>({
  create: () => ({ hunks: [], decorations: Decoration.none, widestOld: 0 }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDiffHunks)) return build(tr.newDoc, e.value.hunks, e.value.language);
    return tr.docChanged ? { ...value, decorations: value.decorations.map(tr.changes) } : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The old file's number for a line of this document, or null on an added line. */
export function oldLineAt(state: EditorState, line: number): number | null {
  const { hunks } = state.field(diffBufferField);
  let lo = 0;
  let hi = hunks.length - 1;
  let before = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hunks[mid].firstNew <= line) {
      before = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (before < 0) return line;
  const hunk = hunks[before];
  const at = line - hunk.firstNew;
  return at < hunk.olds.length ? hunk.olds[at] : line + hunk.deltaAfter;
}

class OldNumber extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }

  eq(other: OldNumber): boolean {
    return other.text === this.text;
  }

  toDOM(): Node {
    return document.createTextNode(this.text);
  }
}

/** The numbers beside a removed-lines widget, one per line it draws. */
class OldNumbers extends GutterMarker {
  constructor(readonly lines: (number | null)[]) {
    super();
  }

  eq(other: OldNumbers): boolean {
    return other.lines.join() === this.lines.join();
  }

  toDOM(): Node {
    const wrap = document.createElement("div");
    for (const n of this.lines) {
      const line = document.createElement("div");
      line.textContent = n === null ? "" : String(n);
      wrap.appendChild(line);
    }
    return wrap;
  }
}

const oldNumberGutter = gutter({
  class: "cm-diff-old-numbers",
  lineMarker: (view, block) => {
    const n = oldLineAt(view.state, view.state.doc.lineAt(block.from).number);
    return n === null ? null : new OldNumber(String(n));
  },
  lineMarkerChange: (update) => update.startState.field(diffBufferField) !== update.state.field(diffBufferField),
  widgetMarker: (_view, widget) =>
    widget instanceof RemovedLines ? new OldNumbers(widget.rows.map((r) => r.oldLine)) : null,
  initialSpacer: (view) => new OldNumber(String(view.state.field(diffBufferField).widestOld)),
  updateSpacer: (_spacer, update) => new OldNumber(String(update.state.field(diffBufferField).widestOld)),
});

/** The field and the old-number gutter. Put it before `lineNumbers()` so the old
 *  column sits left of the new one. */
export function diffBufferExtension(): Extension {
  return [diffBufferField, oldNumberGutter];
}
