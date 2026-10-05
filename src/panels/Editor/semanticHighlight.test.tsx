import { describe, it, expect, afterEach } from "vite-plus/test";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { tags as t } from "@lezer/highlight";
import {
  semanticDecorations,
  semanticHighlight,
  semanticTokenCount,
  setSemanticTokens,
} from "./semanticHighlight";
import type { SemanticToken } from "../../utils/semanticTokens";

// A `.tsx` with no JSX in it, deliberately: the extension is what puts a file in
// the jsdom project, and every claim here is about what CodeMirror actually
// renders. The two that matter are things no unit test could see - that a
// semantic colour beats the grammar's guess for the same run of text, and that
// the decorations survive an edit instead of flashing away on every keystroke.

const token = (
  line: number,
  char: number,
  length: number,
  type: string,
  modifiers: string[] = [],
): SemanticToken => ({ line, char, length, type, modifiers });

/** A named stand-in for `CodeEditor`'s own highlight style. `class` rather than
 *  `color` so the generated element is findable; the real one paints with
 *  `var(--syntax-*)`, which jsdom does not resolve. */
const lexical = HighlightStyle.define([{ tag: t.variableName, class: "lex-var" }]);

let view: EditorView | null = null;

function mount(doc: string, tokens: SemanticToken[]): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [javascript({ typescript: true }), syntaxHighlighting(lexical), semanticHighlight()],
    }),
    parent: document.body,
  });
  view.dispatch({ effects: setSemanticTokens.of(tokens) });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("semanticDecorations", () => {
  const doc = Text.of(["function greet(name) {", "  return name;", "}"]);

  it("places a token at the offset its line and column name", () => {
    const set = semanticDecorations(doc, [token(1, 9, 4, "parameter")]);
    const ranges: [number, number][] = [];
    set.between(0, doc.length, (from, to) => void ranges.push([from, to]));
    // Line 2 starts at 23, so `name` at column 9 is 32..36.
    expect(ranges).toEqual([[32, 36]]);
  });

  it("skips a token whose type nothing paints", () => {
    // A server's own extension type. It must leave the grammar's colour alone
    // rather than wrapping the text in a class with no rule behind it.
    expect(semanticDecorations(doc, [token(0, 9, 5, "selfKeyword")]).size).toBe(0);
  });

  it("drops a token past the end of the document", () => {
    // The caller only applies an answer whose document has not moved, but a
    // malformed response is still a response, and a throw inside a state field
    // update takes the whole editor down rather than losing one colour.
    expect(semanticDecorations(doc, [token(99, 0, 4, "parameter")]).size).toBe(0);
    expect(semanticDecorations(doc, [token(-1, 0, 4, "parameter")]).size).toBe(0);
    expect(semanticDecorations(doc, [token(2, 40, 4, "parameter")]).size).toBe(0);
  });

  it("drops a token at a negative column", () => {
    // Reachable without a malformed response: the wire format is deltas, so one
    // bad `deltaStart` walks the running column below zero, and `line.from +
    // char` then lands inside the *previous* line's text.
    expect(semanticDecorations(doc, [token(1, -3, 4, "parameter")]).size).toBe(0);
  });

  it("clamps a token that would run past its line", () => {
    // `multilineTokenSupport` is advertised as false, so this is a server
    // ignoring that - and a mark spanning half the file is worse than a short one.
    const set = semanticDecorations(doc, [token(0, 9, 500, "function")]);
    const ranges: [number, number][] = [];
    set.between(0, doc.length, (from, to) => void ranges.push([from, to]));
    expect(ranges).toEqual([[9, 22]]);
  });

  it("sorts a response that arrives out of order", () => {
    // An unsorted range set is a thrown error inside a state field, not a wrong
    // colour, so this is not trusted to the encoding's own guarantee.
    const set = semanticDecorations(doc, [token(1, 9, 4, "parameter"), token(0, 9, 5, "function")]);
    expect(set.size).toBe(2);
  });
});

describe("in a mounted editor", () => {
  it("tells a parameter apart from a same-named property", () => {
    // The claim the whole phase rests on. To the grammar both are the four
    // characters `name`; only a server that resolved the program can say which
    // is which, and this is what that looks like on screen.
    const v = mount("function f(name) { return { name: 1 }; }", [
      token(0, 11, 4, "parameter"),
      token(0, 28, 4, "property"),
    ]);
    expect(v.dom.querySelectorAll(".cm-sem-parameter")).toHaveLength(1);
    expect(v.dom.querySelectorAll(".cm-sem-property")).toHaveLength(1);
    expect(v.dom.querySelector(".cm-sem-parameter")?.textContent).toBe("name");
    expect(v.dom.querySelector(".cm-sem-property")?.textContent).toBe("name");
  });

  it("lands inside the grammar's own mark, not around it", () => {
    // Overlapping marks nest, and the *innermost* element is the one whose
    // colour rule paints the text. Higher facet precedence nests further in,
    // which is the opposite of the intuition: at default precedence this field
    // wraps `treeHighlighter`'s span (itself `Prec.high`) and the grammar's
    // guess wins every time, which on screen is indistinguishable from the
    // server never having answered. `Prec.highest` is what this pins.
    const v = mount("function f(name) { return name; }", [token(0, 11, 4, "parameter")]);
    const sem = v.dom.querySelector(".cm-sem-parameter")!;
    // By text, not by position: the function's own name is a `variableName`
    // too, and it comes first in the document.
    const lex = [...v.dom.querySelectorAll(".lex-var")].find((el) => el.textContent === "name")!;
    expect(sem).toBeTruthy();
    expect(lex).toBeTruthy();
    // Either one element carrying both classes, or the semantic one nested
    // within the lexical one. Both are correct; the reverse is not.
    expect(sem === lex || lex.contains(sem)).toBe(true);
  });

  it("strikes a deprecated symbol through without taking its colour", () => {
    const v = mount("obj.old();", [token(0, 4, 3, "method", ["deprecated"])]);
    const el = v.dom.querySelector(".cm-sem-deprecated")!;
    expect(el.classList.contains("cm-sem-method")).toBe(true);
  });

  it("keeps the colours through an edit instead of flashing back to lexical", () => {
    // A refresh is a round trip to a subprocess. Dropping the decorations on
    // every keystroke would leave the file lexically coloured for as long as
    // anyone is typing, so the ranges map through the change and go stale until
    // the next answer lands.
    const v = mount("function f(name) { return name; }", [token(0, 11, 4, "parameter")]);
    v.dispatch({ changes: { from: 0, to: 0, insert: "// a comment\n" } });
    expect(semanticTokenCount(v.state)).toBe(1);
    const moved = v.dom.querySelector(".cm-sem-parameter")!;
    expect(moved.textContent).toBe("name");
  });

  it("replaces the previous answer wholesale rather than merging", () => {
    // Every response describes the entire document: delta requests are not
    // advertised, so anything left over from the last one is a colour the
    // server no longer stands behind.
    const v = mount("function f(name) { return name; }", [token(0, 11, 4, "parameter")]);
    v.dispatch({ effects: setSemanticTokens.of([token(0, 9, 1, "function")]) });
    expect(semanticTokenCount(v.state)).toBe(1);
    expect(v.dom.querySelector(".cm-sem-parameter")).toBeNull();
    expect(v.dom.querySelector(".cm-sem-function")).toBeTruthy();
  });

  it("clears when the server has nothing to say", () => {
    const v = mount("function f(name) {}", [token(0, 11, 4, "parameter")]);
    v.dispatch({ effects: setSemanticTokens.of([]) });
    expect(semanticTokenCount(v.state)).toBe(0);
    expect(v.dom.querySelector(".cm-sem-parameter")).toBeNull();
  });

  it("counts nothing in a state that never had the field", () => {
    // `semanticTokenCount` is asked about the active buffer, and the editor
    // builds one placeholder state without the common extensions.
    const bare = EditorState.create({ doc: "x" });
    expect(semanticTokenCount(bare)).toBe(0);
  });
});
