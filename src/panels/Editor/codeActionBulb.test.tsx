import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CODE_ACTION_MARKER_CLASS, codeActionBulb, codeActionLine, setCodeActionLine } from "./codeActionBulb";

// The bulb is a claim about one line, so the test that matters is what happens
// to that claim when the line moves. jsdom gives every element zero size, so
// nothing here measures: the field's own answer is what is read.

let view: EditorView | null = null;

function mount(doc: string) {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [codeActionBulb({ onClick: () => {} })] }),
    parent: document.body,
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
});

const DOC = "const a = 1\nconst b = 2\nconst c = 3\n";

describe("the code-action bulb", () => {
  it("sits on the line it was given", () => {
    const v = mount(DOC);
    setCodeActionLine(v, 2);
    expect(codeActionLine(v.state)).toBe(2);
  });

  it("follows its line when text is inserted above it", () => {
    const v = mount(DOC);
    setCodeActionLine(v, 2);

    v.dispatch({ changes: { from: 0, insert: "// header\n" } });

    expect(codeActionLine(v.state)).toBe(3);
  });

  it("stays with its own line when Enter is pressed at that line's very start", () => {
    // The whole reason `startSide = 1` is set. At the default side the marker
    // maps to *before* the insertion, so the newly created empty line inherits
    // the bulb and the code it belongs to loses it - a marker that lies about
    // which line it describes rather than merely going missing.
    const v = mount(DOC);
    setCodeActionLine(v, 2);
    const lineStart = v.state.doc.line(2).from;

    v.dispatch({ changes: { from: lineStart, insert: "\n" } });

    expect(codeActionLine(v.state), "the line that kept the code, not the new empty one").toBe(3);
  });

  it("comes off when there is nothing on offer", () => {
    const v = mount(DOC);
    setCodeActionLine(v, 2);
    setCodeActionLine(v, null);

    expect(codeActionLine(v.state)).toBeNull();
    expect(document.querySelectorAll(`.${CODE_ACTION_MARKER_CLASS}`)).toHaveLength(0);
  });

  it("renders exactly one marker, and only while there is an offer", () => {
    const v = mount(DOC);
    expect(document.querySelectorAll(`.${CODE_ACTION_MARKER_CLASS}`), "nothing before an answer").toHaveLength(0);

    setCodeActionLine(v, 2);

    expect(document.querySelectorAll(`.${CODE_ACTION_MARKER_CLASS}`)).toHaveLength(1);
  });

  it("ignores a line the document does not have", () => {
    // A real state, not a bug: the offer was made about a document the file has
    // since been reverted or edited out from under.
    const v = mount(DOC);
    setCodeActionLine(v, 99);
    expect(codeActionLine(v.state)).toBeNull();

    setCodeActionLine(v, 0);
    expect(codeActionLine(v.state)).toBeNull();
  });

  it("reports its line when the bulb is clicked", () => {
    // *Which* line needs layout, which jsdom has none of: every coordinate maps
    // to line 1 here, so the bulb goes on line 1 to be clickable at all. What
    // this can say is that the click is wired and carries a line.
    const clicked: number[] = [];
    const v = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [codeActionBulb({ onClick: (line) => clicked.push(line) })],
      }),
      parent: document.body,
    });
    view = v;
    setCodeActionLine(v, 1);

    document
      .querySelector(`.${CODE_ACTION_MARKER_CLASS}`)!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(clicked).toEqual([1]);
  });
});
