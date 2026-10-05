import { describe, it, expect, afterEach } from "vite-plus/test";
import { EditorState, Text } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { codeLensCount, codeLensDecorations, codeLensExtension, setCodeLenses } from "./codeLensWidget";
import type { CodeLensItem } from "./lspCodeLens";

// A `.tsx` with no JSX in it, deliberately: the extension is what puts a file in
// the jsdom project, and the claims that matter here are about what CodeMirror
// actually renders. Two of them no unit test could see - that the strip lands
// *above* the line it describes rather than below it, and that it survives an
// edit instead of flashing away on every keystroke.

const lens = (line: number, title: string | null): CodeLensItem => ({ line, title, raw: {} });

const doc = Text.of(["function greet(name) {", "  return name;", "}"]);

let view: EditorView | null = null;

function mount(text: string, lenses: CodeLensItem[], on = true): EditorView {
  view = new EditorView({
    state: EditorState.create({ doc: text, extensions: [codeLensExtension(on)] }),
    parent: document.body,
  });
  view.dispatch({ effects: setCodeLenses.of(lenses) });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("where a lens goes", () => {
  it("anchors at the start of the line it describes", () => {
    // Line 2 starts at 23. Anchored at the line's *start*, which with a
    // negative side is what puts the strip above it: the peek widget is
    // anchored at a line's end with a positive side to sit below.
    const set = codeLensDecorations(doc, [lens(2, "3 references")]);
    const at: number[] = [];
    set.between(0, doc.length, (from) => void at.push(from));
    expect(at).toEqual([doc.line(2).from]);
  });

  it("is drawn above the line rather than below it", () => {
    // The whole convention of the feature, and the one thing a wrong `side`
    // would get exactly backwards while still rendering something plausible.
    const set = codeLensDecorations(doc, [lens(2, "3 references")]);
    let spec: { block?: boolean; side?: number } | null = null;
    set.between(0, doc.length, (_from, _to, value) => {
      spec = (value as Decoration).spec as { block?: boolean; side?: number };
    });
    expect(spec!.block).toBe(true);
    expect(spec!.side).toBeLessThan(0);
  });

  it("drops a line the document does not have, rather than throwing", () => {
    // The caller only paints an answer whose document has not moved, but a
    // truncated reply is still a reply, and a throw inside a state field takes
    // the whole editor down rather than losing one label.
    const set = codeLensDecorations(doc, [lens(99, "gone"), lens(0, "before the start"), lens(1, "kept")]);
    let count = 0;
    set.between(0, doc.length, () => void count++);
    expect(count).toBe(1);
  });

  it("draws nothing for a lens that never got a title", () => {
    const set = codeLensDecorations(doc, [lens(1, null)]);
    let count = 0;
    set.between(0, doc.length, () => void count++);
    expect(count).toBe(0);
  });
});

describe("what the buffer does with them", () => {
  it("renders each title", () => {
    const v = mount("const a = 1\nconst b = 2\n", [lens(1, "3 references"), lens(2, "1 implementation")]);
    const strips = [...v.dom.querySelectorAll(".cm-codeLens")];
    expect(strips.map((s) => s.textContent)).toEqual(["3 references", "1 implementation"]);
  });

  it("puts several lenses on one line side by side, not on top of each other", () => {
    // Two block widgets at one position are two *rows*: the function would be
    // pushed two lines down the file instead of carrying two labels.
    //
    // Both halves are asserted, and the second is the one an earlier version of
    // this test was missing: counting the strips says the widgets were merged,
    // but a merge that kept only the last title counts exactly the same.
    const v = mount("const a = 1\nconst b = 2\n", [lens(2, "3 references"), lens(2, "1 implementation")]);
    const strips = [...v.dom.querySelectorAll(".cm-codeLens")];
    expect(strips).toHaveLength(1);
    expect([...strips[0].querySelectorAll(".cm-codeLens-item")].map((s) => s.textContent)).toEqual([
      "3 references",
      "1 implementation",
    ]);
  });

  it("keeps them through an edit instead of flashing away on every keystroke", () => {
    // A refresh is a round trip to a subprocess. Dropping the widgets on each
    // change would make every line in the file jump up and down the whole time
    // anyone is typing; mapping lets them go stale until the next answer.
    const v = mount("const a = 1\nconst b = 2\n", [lens(2, "3 references")]);
    expect(codeLensCount(v.state)).toBe(1);
    v.dispatch({ changes: { from: 0, insert: "// header\n" } });
    expect(codeLensCount(v.state)).toBe(1);
    expect(v.dom.querySelector(".cm-codeLens")?.textContent).toBe("3 references");
  });

  it("replaces the whole set rather than accumulating", () => {
    // There is no incremental form: a `textDocument/codeLens` reply describes
    // the whole document, so a second answer is the answer and not an addition.
    const v = mount("const a = 1\nconst b = 2\n", [lens(1, "one"), lens(2, "two")]);
    v.dispatch({ effects: setCodeLenses.of([lens(1, "only")]) });
    expect([...v.dom.querySelectorAll(".cm-codeLens")].map((s) => s.textContent)).toEqual(["only"]);
  });

  it("holds nothing at all when the setting is off", () => {
    // Switching off is a compartment reconfigure that takes the field and its
    // decorations with it, so there is nothing left to clear - which is also
    // why an effect dispatched into a buffer with no field is harmless.
    const v = mount("const a = 1\n", [lens(1, "3 references")], false);
    expect(codeLensCount(v.state)).toBe(0);
    expect(v.dom.querySelector(".cm-codeLens")).toBe(null);
  });
});
