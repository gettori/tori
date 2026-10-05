// Git's hunks laid over the file they describe: added lines tinted where they
// sit, removed lines drawn as block widgets where they were removed, and the old
// file's numbers in a gutter of their own. Behind the fence.
import {
  BlockType,
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  type BlockInfo,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type StateCommand,
  type Text,
} from "@codemirror/state";
import type { Language } from "@codemirror/language";
import { HIGHLIGHT_MAX } from "../Chat/highlight";
import type { DiffHunk } from "../../utils/diffHunks";
import { buildRows, changedRange, hunkGaps, type DiffRow } from "../../utils/diffView";
import { overlay } from "../../utils/syntaxRows";
import { tokenLines, type Span } from "./syntaxLines";

type Placed = {
  firstNew: number;
  changeAt: number;
  from: number;
  to: number;
  olds: (number | null)[];
  addRows: (number | null)[];
  removed: { pos: number; rows: number[] }[];
  deltaAfter: number;
};

type Run = { rows: DiffRow[]; spans: (Span[] | null)[]; indices: number[] };

export type DiffBufferState = {
  hunks: Placed[];
  decorations: DecorationSet;
  widestOld: number;
  actionAt: Map<number, number>;
};

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
        (r, i) =>
          r.text === this.rows[i].text && r.oldLine === this.rows[i].oldLine && !other.spans[i] === !this.spans[i],
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

const clampLine = (doc: Text, line: number) => Math.min(Math.max(line, 1), doc.lines);

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
    let run: Run | null = null;
    let changeAt: number | null = null;

    const place = (done: Run) => {
      const at = removedAt(doc, nextNew, new RemovedLines(done.rows, done.spans));
      ranges.push(at);
      changeAt ??= at.from;
      removed.push({ pos: at.from, rows: done.indices });
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind === "meta") continue;
      if (row.kind === "del") {
        run ??= { rows: [], spans: [], indices: [] };
        run.rows.push(row);
        run.spans.push(spans?.[i] ?? null);
        run.indices.push(i);
      } else if (run) {
        place(run);
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
      changeAt ??= line.from;
      ranges.push(addedLine.range(line.from));
      const range = row.segs ? changedRange(row.segs) : null;
      const to = range ? Math.min(range[1], line.length) : 0;
      if (range && range[0] < to) ranges.push(addedWord.range(line.from + range[0], line.from + to));
    }
    if (run) place(run);

    const startLine = clampLine(doc, firstNew);
    const endLine = clampLine(doc, Math.max(firstNew + olds.length - 1, startLine));
    hunks.push({
      firstNew,
      changeAt: changeAt ?? doc.line(startLine).from,
      from: Math.min(doc.line(startLine).from, removed[0]?.pos ?? Infinity),
      to: Math.max(doc.line(endLine).to, removed[removed.length - 1]?.pos ?? -1),
      olds,
      addRows,
      removed,
      deltaAfter: nextOld - nextNew,
    });
    actionAt.set(startLine, index);
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

function changeCommand(forward: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const { hunks } = state.field(diffBufferField);
    if (!hunks.length) return false;
    const here = state.doc.lineAt(state.selection.main.head).number;
    const lineOf = (hunk: Placed) => state.doc.lineAt(hunk.changeAt).number;
    const target = forward
      ? (hunks.find((h) => lineOf(h) > here) ?? hunks[0])
      : ([...hunks].reverse().find((h) => lineOf(h) < here) ?? hunks[hunks.length - 1]);
    dispatch(
      state.update({
        selection: { anchor: target.changeAt },
        effects: EditorView.scrollIntoView(target.changeAt, { y: "center" }),
        userEvent: "select",
      }),
    );
    return true;
  };
}

export const nextChange = changeCommand(true);
export const previousChange = changeCommand(false);

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
    let lo = 0;
    let hi = hunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hunks[mid].to < range.from) lo = mid + 1;
      else hi = mid;
    }
    for (let index = lo; index < hunks.length && hunks[index].from <= range.to; index++) {
      const hunk = hunks[index];
      hunk.addRows.forEach((row, at) => {
        const line = hunk.firstNew + at;
        if (row !== null && line >= first && line <= last) pick(index, row);
      });
      // A widget has no text to select into, so touching its edge takes its lines.
      for (const run of hunk.removed) {
        if (range.from <= run.pos && run.pos <= range.to) for (const row of run.rows) pick(index, row);
      }
    }
  }
  return [...picked].map(([hunk, rows]) => ({ hunk, lines: [...rows].sort((a, b) => a - b) }));
}

const revealLines = StateEffect.define<number>();

class HiddenLines extends WidgetType {
  constructor(readonly count: number) {
    super();
  }

  eq(other: HiddenLines): boolean {
    return other.count === this.count;
  }

  toDOM(view: EditorView): HTMLElement {
    const band = document.createElement("div");
    band.className = "cm-diff-hidden";
    band.textContent = `\u22ef ${this.count} unchanged line${this.count === 1 ? "" : "s"}`;
    band.onclick = () => view.dispatch({ effects: revealLines.of(view.posAtDOM(band)) });
    return band;
  }
}

function hiddenGaps(doc: Text, hunks: DiffHunk[]): DecorationSet {
  const spans = hunkGaps(hunks).map((g) => [g.start, g.end]);
  const last = hunks[hunks.length - 1];
  // `hunkGaps` leaves the tail out because a diff does not know the file's
  // length. The buffer does, unless the file is empty.
  if (last && doc.length) spans.push([last.endLine + 1, doc.lines]);
  const ranges = spans
    .filter(([start, end]) => start <= end && end <= doc.lines)
    .map(([start, end]) =>
      Decoration.replace({ widget: new HiddenLines(end - start + 1), block: true }).range(
        doc.line(start).from,
        doc.line(end).to,
      ),
    );
  return Decoration.set(ranges);
}

const hiddenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let hidden = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDiffHunks)) hidden = hiddenGaps(tr.newDoc, e.value.hunks);
      if (e.is(revealLines)) hidden = hidden.update({ filter: (from, to) => e.value < from || to < e.value });
    }
    // Find can select text inside a folded stretch, so that stretch opens.
    const ranges = tr.selection?.ranges ?? [];
    if (ranges.length) {
      hidden = hidden.update({
        filter: (from, to) =>
          !ranges.some((r) => from <= r.from && r.to <= to && (!r.empty || (from < r.head && r.head < to))),
      });
    }
    return hidden;
  },
  provide: (field) => EditorView.decorations.from(field),
});

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

// Before `lineNumbers()`, so the old column sits left of the new one.
export function diffBufferExtension(): Extension {
  return [diffBufferField, hiddenField, oldNumberGutter];
}

export type ChangeSpan = { side: "old" | "new"; from: number; to: number };

export function changeSpans(state: EditorState): ChangeSpan[] {
  const { doc } = state;
  const out: ChangeSpan[] = [];
  for (const hunk of state.field(diffBufferField).hunks) {
    for (const run of hunk.removed) out.push({ side: "old", from: run.pos, to: run.pos });
    let start: number | null = null;
    for (let at = 0; at <= hunk.addRows.length; at++) {
      const line = hunk.firstNew + at;
      if (at < hunk.addRows.length && hunk.addRows[at] !== null && line <= doc.lines) {
        start ??= line;
      } else if (start !== null) {
        out.push({ side: "new", from: doc.line(start).from, to: doc.line(line - 1).to });
        start = null;
      }
    }
  }
  return out;
}

// A line block holds the removed-lines widget above its text, so each side
// measures its own part of the block.
function partAt(view: EditorView, pos: number, pick: (part: BlockInfo) => boolean): BlockInfo {
  const block = view.lineBlockAt(pos);
  return (Array.isArray(block.type) ? block.type.find(pick) : null) ?? block;
}

class OverviewRuler {
  readonly dom = document.createElement("div");
  readonly strips = { old: document.createElement("div"), new: document.createElement("div") };

  constructor(readonly view: EditorView) {
    this.dom.className = "cm-diff-overview";
    this.dom.setAttribute("aria-hidden", "true");
    this.strips.old.className = "cm-diff-overview-old";
    this.strips.new.className = "cm-diff-overview-new";
    this.dom.append(this.strips.old, this.strips.new);
    view.dom.appendChild(this.dom);
    this.place();
    this.draw();
  }

  update(update: ViewUpdate) {
    if (update.geometryChanged) this.place();
    if (
      update.heightChanged ||
      update.geometryChanged ||
      update.startState.field(diffBufferField) !== update.state.field(diffBufferField)
    ) {
      this.draw();
    }
  }

  draw() {
    const total = this.view.contentHeight || 1;
    this.strips.old.replaceChildren();
    this.strips.new.replaceChildren();
    const isText = (b: BlockInfo) => b.type === BlockType.Text;
    for (const span of changeSpans(this.view.state)) {
      const first = partAt(
        this.view,
        span.from,
        span.side === "old" ? (b) => b.widget instanceof RemovedLines : isText,
      );
      const last = span.side === "old" ? first : partAt(this.view, span.to, isText);
      const mark = document.createElement("div");
      mark.className = "cm-diff-overview-mark";
      mark.style.top = `${(first.top / total) * 100}%`;
      mark.style.height = `${((last.bottom - first.top) / total) * 100}%`;
      this.strips[span.side].appendChild(mark);
    }
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

export function diffOverviewRuler(): Extension {
  return [ViewPlugin.fromClass(OverviewRuler), EditorView.editorAttributes.of({ class: "cm-diff-overview-host" })];
}

export type HunkAction = "apply" | "discard";

export type HunkActions = { staged: () => boolean; run: (hunk: number, action: HunkAction) => void };

export const setHunksBusy = StateEffect.define<boolean>();

const busyField = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((busy, e) => (e.is(setHunksBusy) ? e.value : busy), value),
});

const SVG_NS = "http://www.w3.org/2000/svg";
// Lucide's plus, minus and undo-2, drawn by hand for codeActionBulb.ts's reason:
// this module sits behind the lazy editor edge and builds its DOM without Solid.
const PLUS_PATHS = ["M5 12h14", "M12 5v14"];
const MINUS_PATHS = ["M5 12h14"];
const UNDO_PATHS = ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"];

function actionButton(paths: string[], label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-diff-hunk-action";
  button.title = label;
  button.disabled = disabled;
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
    readonly busy: boolean,
    readonly run: HunkActions["run"],
  ) {
    super();
  }

  eq(other: HunkButtons): boolean {
    return other.hunk === this.hunk && other.staged === this.staged && other.busy === this.busy;
  }

  toDOM(): Node {
    const wrap = document.createElement("div");
    wrap.className = "cm-diff-hunk-buttons";
    const label = this.staged ? "Unstage this hunk" : "Stage this hunk";
    wrap.appendChild(
      actionButton(this.staged ? MINUS_PATHS : PLUS_PATHS, label, this.busy, () => this.run(this.hunk, "apply")),
    );
    if (!this.staged) {
      wrap.appendChild(
        actionButton(UNDO_PATHS, "Throw away this hunk", this.busy, () => this.run(this.hunk, "discard")),
      );
    }
    return wrap;
  }
}

export function hunkActionGutter(actions: HunkActions): Extension {
  return [
    busyField,
    gutter({
      class: "cm-diff-hunk-actions",
      lineMarker: (view, block) => {
        const hunk = view.state.field(diffBufferField).actionAt.get(view.state.doc.lineAt(block.from).number);
        if (hunk === undefined) return null;
        return new HunkButtons(hunk, actions.staged(), view.state.field(busyField), actions.run);
      },
      lineMarkerChange: (update) =>
        update.startState.field(diffBufferField) !== update.state.field(diffBufferField) ||
        update.startState.field(busyField) !== update.state.field(busyField),
      initialSpacer: () => new HunkButtons(0, actions.staged(), false, () => {}),
    }),
  ];
}
