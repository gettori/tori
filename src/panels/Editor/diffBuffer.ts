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

type Placed = {
  firstNew: number;
  olds: (number | null)[];
  addRows: (number | null)[];
  removed: { pos: number; rows: number[] }[];
  deltaAfter: number;
};

export type DiffBufferState = {
  hunks: Placed[];
  decorations: DecorationSet;
  widestOld: number;
  actionAt: Map<number, number>;
};

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
  const actionAt = new Map<number, number>();
  let widestOld = doc.lines;

  for (const [index, hunk] of input.entries()) {
    const rows = buildRows(hunk.lines, { old: hunk.oldStart, new: hunk.startLine });
    const spans = oldSpans(rows, language);
    let nextOld = hunk.oldStart;
    // A hunk with nothing left on the new side (`+N,0`) names the line before it.
    let nextNew = rows.some((r) => r.newLine !== null) ? hunk.startLine : hunk.startLine + 1;
    const firstNew = nextNew;
    const olds: (number | null)[] = [];
    const addRows: (number | null)[] = [];
    const removed: Placed["removed"] = [];
    let run: { rows: DiffRow[]; spans: (Span[] | null)[]; indices: number[] } | null = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind === "meta") continue;
      if (row.kind === "del") {
        run ??= { rows: [], spans: [], indices: [] };
        run.rows.push(row);
        run.spans.push(spans?.[i] ?? null);
        run.indices.push(i);
      } else if (run) {
        const at = removedAt(doc, nextNew, new RemovedLines(run.rows, run.spans));
        ranges.push(at);
        removed.push({ pos: at.from, rows: run.indices });
        run = null;
      }
      if (row.oldLine !== null) {
        nextOld = row.oldLine + 1;
        widestOld = Math.max(widestOld, row.oldLine);
      }
      if (row.newLine === null) continue;
      nextNew = row.newLine + 1;
      olds.push(row.oldLine);
      addRows.push(row.kind === "add" ? i : null);
      if (row.kind !== "add" || row.newLine > doc.lines) continue;
      const line = doc.line(row.newLine);
      ranges.push(addedLine.range(line.from));
      const range = row.segs ? changedRange(row.segs) : null;
      const to = range ? Math.min(range[1], line.length) : 0;
      if (range && range[0] < to) ranges.push(addedWord.range(line.from + range[0], line.from + to));
    }
    if (run) {
      const at = removedAt(doc, nextNew, new RemovedLines(run.rows, run.spans));
      ranges.push(at);
      removed.push({ pos: at.from, rows: run.indices });
    }

    hunks.push({ firstNew, olds, addRows, removed, deltaAfter: nextOld - nextNew });
    actionAt.set(Math.min(Math.max(firstNew, 1), doc.lines), index);
  }

  const last = hunks[hunks.length - 1];
  if (last) widestOld = Math.max(widestOld, doc.lines + last.deltaAfter);
  return { hunks, decorations: Decoration.set(ranges, true), widestOld, actionAt };
}

export const diffBufferField = StateField.define<DiffBufferState>({
  create: () => ({ hunks: [], decorations: Decoration.none, widestOld: 0, actionAt: new Map() }),
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

/** The changed rows the selection covers, by hunk index, as indices into each
 *  hunk's body: the same numbers line staging sends from the rows. */
export function selectedRows(state: EditorState): { hunk: number; lines: number[] }[] {
  const { hunks } = state.field(diffBufferField);
  const picked = new Map<number, Set<number>>();
  const pick = (hunk: number, row: number) => {
    if (!picked.has(hunk)) picked.set(hunk, new Set());
    picked.get(hunk)!.add(row);
  };
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const first = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to);
    // A selection that stops at a line's start has not taken that line.
    const last = end.from === range.to && end.number > first ? end.number - 1 : end.number;
    hunks.forEach((hunk, index) => {
      hunk.addRows.forEach((row, at) => {
        const line = hunk.firstNew + at;
        if (row !== null && line >= first && line <= last) pick(index, row);
      });
      // A widget has no text to select into, so touching its edge takes its lines.
      for (const run of hunk.removed) {
        if (range.from <= run.pos && run.pos <= range.to) for (const row of run.rows) pick(index, row);
      }
    });
  }
  return [...picked].map(([hunk, rows]) => ({ hunk, lines: [...rows].sort((a, b) => a - b) }));
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

export type HunkAction = "apply" | "discard";

/** Whether the tab is the staged half, and what a hunk's buttons do. */
export type HunkActions = { staged: () => boolean; run: (hunk: number, action: HunkAction) => void };

const SVG_NS = "http://www.w3.org/2000/svg";
// Lucide's plus, minus and undo-2, drawn by hand for codeActionBulb.ts's reason:
// this module sits behind the lazy editor edge and builds its DOM without Solid.
const PLUS_PATHS = ["M5 12h14", "M12 5v14"];
const MINUS_PATHS = ["M5 12h14"];
const UNDO_PATHS = ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"];

function actionButton(paths: string[], label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-diff-hunk-action";
  button.title = label;
  button.setAttribute("aria-label", label);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  button.appendChild(svg);
  // Keeps the caret and the selection where they are, which line staging reads.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.onclick = onClick;
  return button;
}

class HunkButtons extends GutterMarker {
  constructor(
    readonly hunk: number,
    readonly staged: boolean,
    readonly run: HunkActions["run"],
  ) {
    super();
  }

  eq(other: HunkButtons): boolean {
    return other.hunk === this.hunk && other.staged === this.staged;
  }

  toDOM(): Node {
    const wrap = document.createElement("div");
    wrap.className = "cm-diff-hunk-buttons";
    wrap.appendChild(
      actionButton(this.staged ? MINUS_PATHS : PLUS_PATHS, this.staged ? "Unstage this hunk" : "Stage this hunk", () =>
        this.run(this.hunk, "apply"),
      ),
    );
    if (!this.staged) {
      wrap.appendChild(actionButton(UNDO_PATHS, "Throw away this hunk", () => this.run(this.hunk, "discard")));
    }
    return wrap;
  }
}

/** Stage, unstage and discard beside each hunk's first line, by the hunk's index
 *  in the list the buffer was given. */
export function hunkActionGutter(actions: HunkActions): Extension {
  return gutter({
    class: "cm-diff-hunk-actions",
    lineMarker: (view, block) => {
      const hunk = view.state.field(diffBufferField).actionAt.get(view.state.doc.lineAt(block.from).number);
      return hunk === undefined ? null : new HunkButtons(hunk, actions.staged(), actions.run);
    },
    lineMarkerChange: (update) => update.startState.field(diffBufferField) !== update.state.field(diffBufferField),
    initialSpacer: () => new HunkButtons(0, actions.staged(), () => {}),
  });
}
