// What the caret-jump listener reports, against a real EditorView.
//
// `isSignificantMove` is unit-tested on two numbers; this is the other half of
// the claim, that the numbers handed to it come from the right places and that
// the three guards actually hold. Both matter: a threshold that is right about
// line numbers it reads off the wrong state records a jump on every tab click.
import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { caretListener, cursorJumpListener } from "./cursorJump";
import { JUMP_LINE_THRESHOLD } from "../../utils/jumpList";

const DOC = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");

let view: EditorView | undefined;
let host: HTMLElement | undefined;
let reported: number[] = [];

/** Position of the first character of a 1-based line. */
const startOf = (line: number) => view!.state.doc.line(line).from;

function mount(doc = DOC, at = 1): EditorView {
  reported = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [cursorJumpListener((line) => reported.push(line))],
    }),
  });
  view.dispatch({ selection: { anchor: startOf(at) } });
  reported = [];
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = host = undefined;
});

describe("what the caret reports as a jump", () => {
  it("says nothing while the caret drifts a line at a time", () => {
    mount(DOC, 40);
    for (let line = 41; line <= 40 + JUMP_LINE_THRESHOLD * 2; line++) {
      view!.dispatch({ selection: { anchor: startOf(line) } });
    }
    expect(reported).toEqual([]);
  });

  it("reports one line for one long jump, in either direction", () => {
    mount(DOC, 40);
    view!.dispatch({ selection: { anchor: startOf(300) } });
    expect(reported).toEqual([300]);
    view!.dispatch({ selection: { anchor: startOf(12) } });
    expect(reported).toEqual([300, 12]);
  });

  it("ignores an edit that moves the caret a long way", () => {
    // Typing at the end of a paste is not navigation, and a list full of edits
    // is a list nobody can walk back through.
    mount(DOC, 1);
    view!.dispatch({
      changes: { from: 0, insert: `${"pasted\n".repeat(50)}` },
      selection: { anchor: "pasted\n".repeat(50).length },
    });
    expect(reported).toEqual([]);
  });

  it("ignores a transaction that left the selection alone", () => {
    mount(DOC, 40);
    const before = view!.state.selection.main.head;
    view!.dispatch({ annotations: [] });
    expect(view!.state.selection.main.head).toBe(before);
    expect(reported).toEqual([]);
  });

  // The guard with the sharpest failure: `setState` is how a tab switch swaps
  // one file's buffer for another's. It arrives with no transactions and a start
  // state belonging to the *previous* file, so line 300 of the old document and
  // line 1 of the new one would subtract to a jump nobody made.
  it("ignores a whole-state swap, which is what a tab change looks like", () => {
    mount(DOC, 300);
    view!.setState(
      EditorState.create({
        doc: "a\nb\nc",
        extensions: [cursorJumpListener((line) => reported.push(line))],
      }),
    );
    expect(reported).toEqual([]);
  });
});

// The other listener in the same file, wanting the opposite: every position,
// because the breadcrumb trail has to name the symbol the caret is in *now*.
describe("what the caret reports to the breadcrumb trail", () => {
  let moves: [number, number][] = [];

  function mountCaret(doc = DOC, at = 1): EditorView {
    moves = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [caretListener((line, column) => moves.push([line, column]))],
      }),
    });
    view.dispatch({ selection: { anchor: startOf(at) } });
    moves = [];
    return view;
  }

  it("reports drift, which the jump listener exists to throw away", () => {
    mountCaret(DOC, 40);
    view!.dispatch({ selection: { anchor: startOf(41) } });
    view!.dispatch({ selection: { anchor: startOf(42) } });
    expect(moves).toEqual([
      [41, 1],
      [42, 1],
    ]);
  });

  it("reports the column, not only the line", () => {
    // Two symbols can share a line; without the column the trail cannot say
    // which of them holds the caret.
    mountCaret(DOC, 10);
    view!.dispatch({ selection: { anchor: startOf(10) + 4 } });
    expect(moves).toEqual([[10, 5]]);
  });

  it("reports where an edit left the caret", () => {
    // Typing a newline changes which line the caret is on, and pressing Enter at
    // the end of a function is exactly when the trail should stop naming it.
    mountCaret(DOC, 1);
    view!.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1 } });
    expect(moves).toEqual([[1, 2]]);
  });

  it("hears nothing from a whole-state swap, which is why the pane reports one", () => {
    // `setState` does not reach an update listener at all, in either direction:
    // the buffer being put away sees nothing, and so does the one arriving. This
    // is the fact `CodeEditor.swapTo` exists to cover, by reporting the caret of
    // the buffer it just showed. Left as a test because it is the assumption the
    // whole trail rests on, and it is not one this file can enforce.
    mountCaret(DOC, 300);
    view!.setState(
      EditorState.create({
        doc: "a\nb\nc",
        selection: { anchor: 2 },
        extensions: [caretListener((line, column) => moves.push([line, column]))],
      }),
    );
    expect(moves).toEqual([]);
  });

  it("stays quiet on an update that left the caret alone", () => {
    mountCaret(DOC, 40);
    view!.dispatch({ annotations: [] });
    expect(moves).toEqual([]);
  });
});
