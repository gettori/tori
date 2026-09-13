import { describe, it, expect } from "vitest";
import { EditorState, type StateCommand } from "@codemirror/state";
import { parseDiffHunks } from "../../utils/diffHunks";
import type { DiffRow } from "../../utils/diffView";
import {
  changeSpans,
  diffBufferExtension,
  diffBufferField,
  nextChange,
  oldLineAt,
  previousChange,
  setDiffHunks,
} from "./diffBuffer";

const DOC = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

// Line 3 rewritten, lines 12 and 13 inserted, and two lines removed after 25.
const DIFF = [
  "@@ -1,6 +1,6 @@",
  " line 1",
  " line 2",
  "-line three",
  "+line 3",
  " line 4",
  " line 5",
  " line 6",
  "@@ -9,6 +9,8 @@",
  " line 9",
  " line 10",
  " line 11",
  "+line 12",
  "+line 13",
  " line 14",
  " line 15",
  " line 16",
  "@@ -21,8 +23,6 @@",
  " line 23",
  " line 24",
  " line 25",
  "-gone a",
  "-gone b",
  " line 26",
  " line 27",
  " line 28",
].join("\n");

function load(diff = DIFF): EditorState {
  const state = EditorState.create({ doc: DOC, extensions: diffBufferExtension() });
  return state.update({ effects: setDiffHunks.of({ hunks: parseDiffHunks(diff), language: null }) }).state;
}

type Found = { line: number; from: number; to: number; cls?: string; removed?: string[]; removedOld?: (number | null)[] };

function decorations(state: EditorState): Found[] {
  const out: Found[] = [];
  state.field(diffBufferField).decorations.between(0, state.doc.length, (from, to, deco) => {
    const widget = deco.spec.widget as { rows: DiffRow[] } | undefined;
    out.push({
      line: state.doc.lineAt(from).number,
      from,
      to,
      cls: deco.spec.class,
      removed: widget?.rows.map((r) => r.text),
      removedOld: widget?.rows.map((r) => r.oldLine),
    });
  });
  return out;
}

describe("the diff buffer's decorations", () => {
  it("draws removed lines where they were removed, once per hunk that removed any", () => {
    const widgets = decorations(load()).filter((d) => d.removed);
    expect(widgets.map((w) => [w.line, w.removed])).toEqual([
      [3, ["-line three"]],
      [26, ["-gone a", "-gone b"]],
    ]);
  });

  it("tints the added lines and nothing else", () => {
    const lines = decorations(load()).filter((d) => d.cls === "cm-diff-line-added");
    expect(lines.map((d) => d.line)).toEqual([3, 12, 13]);
  });

  it("marks the changed characters of a rewrite, and none on a pure insertion", () => {
    const state = load();
    const words = decorations(state).filter((d) => d.cls === "cm-diff-word-added");
    expect(words.map((w) => [w.line, state.doc.sliceString(w.from, w.to)])).toEqual([[3, "3"]]);
  });

  it("puts a removal at the end of the file after the last line", () => {
    const state = load(["@@ -29,3 +29,2 @@", " line 29", " line 30", "-gone"].join("\n"));
    const widgets = decorations(state).filter((d) => d.removed);
    expect(widgets).toHaveLength(1);
    expect(widgets[0].from).toBe(state.doc.length);
  });
});

describe("the old-number gutter", () => {
  it("numbers context from the old file and leaves added lines blank", () => {
    const state = load();
    const olds = (lines: number[]) => lines.map((n) => [n, oldLineAt(state, n)]);
    expect(olds([1, 2, 3, 4, 11, 12, 13, 14, 20, 25, 26, 30])).toEqual([
      [1, 1],
      [2, 2],
      [3, null],
      [4, 4],
      [11, 11],
      [12, null],
      [13, null],
      [14, 12],
      [20, 18],
      [25, 23],
      [26, 26],
      [30, 30],
    ]);
  });

  it("numbers the removed lines from the old file", () => {
    const widgets = decorations(load()).filter((d) => d.removedOld);
    expect(widgets.map((w) => w.removedOld)).toEqual([[3], [24, 25]]);
  });
});

describe("moving between changes", () => {
  it("lands on each hunk's first change in turn from the top, and wraps both ways", () => {
    let state = load();
    const go = (command: StateCommand) => {
      command({ state, dispatch: (tr) => (state = tr.state) });
      return state.doc.lineAt(state.selection.main.head).number;
    };
    expect([go(nextChange), go(nextChange), go(nextChange), go(nextChange)]).toEqual([3, 12, 26, 3]);
    expect(go(previousChange)).toBe(26);
  });
});

describe("the overview ruler's spans", () => {
  it("puts removed runs on the old strip and added runs on the new one", () => {
    const state = load();
    const line = (pos: number) => state.doc.lineAt(pos).number;
    expect(changeSpans(state).map((s) => [s.side, line(s.from), line(s.to)])).toEqual([
      ["old", 3, 3],
      ["new", 3, 3],
      ["new", 12, 13],
      ["old", 26, 26],
    ]);
  });
});
