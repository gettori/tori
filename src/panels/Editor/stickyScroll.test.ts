// The scope chain, without a view.
//
// Which scopes enclose a position is a question about an EditorState and the
// tree parsed into it, so it is asked here. Whether the resulting rows are
// pinned in the right place on screen is a question about layout, which jsdom
// cannot answer and this file does not ask; `stickyScrollGate.test.tsx` covers
// the part of the overlay that is real without geometry.
import { describe, it, expect } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { stickyHeaders, MAX_STICKY } from "./stickyScroll";

const CODE = `class Widget {
  render() {
    if (this.open) {
      for (const child of this.children) {
        child.draw()
      }
    }
  }
}
`;

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [javascript()] });
}

/** The chain above the *start* of a 1-based line, as line numbers. */
function above(doc: string, line: number, max?: number) {
  const state = stateFor(doc);
  return stickyHeaders(state, state.doc.line(line).from, max).map((h) => h.line);
}

describe("the scopes above the top of the screen", () => {
  it("returns the chain that encloses a nested line, outermost first", () => {
    // Line 5 is `child.draw()`, four scopes deep.
    expect(above(CODE, 5)).toEqual([1, 2, 3, 4]);
  });

  it("shortens as the top of the screen moves out of the nesting", () => {
    // Scrolling down through a block is exactly this: the same call with a
    // larger line number, and the chain grows and shrinks with the nesting.
    expect(above(CODE, 3)).toEqual([1, 2]);
    expect(above(CODE, 4)).toEqual([1, 2, 3]);
    expect(above(CODE, 5)).toEqual([1, 2, 3, 4]);
    expect(above(CODE, 6)).toEqual([1, 2, 3, 4]);
  });

  it("never pins a line that is already on screen", () => {
    // The top visible line is line 1 here, so `class Widget {` needs no help.
    expect(above(CODE, 1)).toEqual([]);
  });

  it("leaves the document root out, so an unnested line pins nothing", () => {
    // Two top-level statements: standing on the second, nothing encloses it but
    // the file, and pinning line 1 of every file would say nothing.
    expect(above("const a = 1\nconst b = 2\n", 2)).toEqual([]);
  });

  it("gives one row to a line that is several nested nodes", () => {
    // `export default function f() {` is an export, a declaration and a block,
    // all starting at the same character. A reader sees one line, so one row.
    expect(above("export default function f() {\n  const x = 1\n  return x\n}\n", 3)).toEqual([1]);
  });

  it("carries the line as written, so the indent survives", () => {
    const state = stateFor(CODE);
    const rows = stickyHeaders(state, state.doc.line(5).from);
    expect(rows.map((h) => h.text)).toEqual([
      "class Widget {",
      "  render() {",
      "    if (this.open) {",
      "      for (const child of this.children) {",
      ]);
    // `from` is the start of the header's own line, which is where clicking the
    // row scrolls to.
    expect(rows[0].from).toBe(state.doc.line(1).from);
  });

  it("drops the deepest scopes rather than the outermost when capped", () => {
    // The outer ones say where in the file you are, which nothing else on screen
    // does; the innermost is a few lines up and comes back as you scroll.
    expect(above(CODE, 5, 2)).toEqual([1, 2]);
    expect(above(CODE, 5, 1)).toEqual([1]);
  });

  it("caps at MAX_STICKY without being asked", () => {
    const deep = `${Array.from({ length: 12 }, (_, i) => `${"  ".repeat(i)}function f${i}() {`).join("\n")}\n${"  ".repeat(12)}done()\n`;
    expect(above(deep, 13).length).toBe(MAX_STICKY);
  });

  it("says nothing for a grammar with no tree to speak of", () => {
    // A buffer with no language attached: the tree is one flat node, so there is
    // no nesting to report. Empty rather than guessed from the indentation,
    // which would be a second idea of what a scope is.
    const plain = EditorState.create({ doc: CODE });
    expect(stickyHeaders(plain, plain.doc.line(5).from)).toEqual([]);
  });

  it("does not pin a scope that opened on a blank line", () => {
    // A row of empty stripe over the file says less than no row at all.
    const doc = "\nfunction f() {\n  a()\n  b()\n}\n";
    expect(above(doc, 4)).toEqual([2]);
  });
});
