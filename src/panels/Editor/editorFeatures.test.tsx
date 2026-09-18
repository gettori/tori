// What the comfort extensions actually put on screen, in a real EditorView.
//
// The prefs unit test asserts which features are *chosen*; this one asserts the
// chosen ones render, because "the setting is on" and "there are guides in the
// buffer" are separate claims and only the second is the ticket. jsdom has no
// layout, but CodeMirror still builds its DOM, which is where both of these
// features live: a class on the line for the guides, a widget for the swatches.
import { describe, it, expect, afterEach } from "vitest";
import { EditorView, gutter } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle, forceParsing } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { editorPrefExtensions } from "./editorPrefs";
import { DEPTH_COLORS } from "./bracketPairs";
import { MINIMAP_CLASS } from "./minimap";
import { STICKY_CLASS, STICKY_ROW_CLASS } from "./stickyScroll";
import { langForPath } from "./languages";
import type { EditorDefaults } from "../Settings/settingsStore";

const BASE: EditorDefaults = {
  // Not what this suite is about, but part of the type: format-on-save and vim
  // are editor behaviour too, and neither resolves to an extension here.
  formatOnSave: false,
  organizeImportsOnSave: false,
  codeLens: false,
  vimMode: false,
  indentGuides: false,
  activeLineHighlight: "none",
  softWrap: false,
  renderWhitespace: false,
  scrollPastEnd: false,
  rainbowBrackets: false,
  bracketPairGuides: false,
  minimap: false,
  stickyScroll: false,
  wordCompletion: true,
  hotExit: true,
  compactFolders: true,
  todoPatterns: "TODO,FIXME,HACK,XXX",
};

const INDENTED = "function a() {\n    if (x) {\n        deep();\n    }\n}";
/** Somewhere inside the innermost block, so there is an active block to mark. */
const INSIDE_DEEP = INDENTED.indexOf("deep()");

let view: EditorView | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = host = undefined;
});

function mount(doc: string, extensions: Extension, selection?: number): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions,
      selection: selection === undefined ? undefined : { anchor: selection },
    }),
  });
  // Anything decorated from the syntax tree - the bracket guides, the rainbow
  // brackets - is only there once the parse has reached it, and the first parse
  // runs under a 25ms wall-clock budget it can miss on a loaded machine. Left
  // to the background worker this is a coin flip: `expected 4 but got 0`, seen
  // once in six full-suite runs here and never in a single-file one. Same cause
  // as bracketPairs.test.tsx, same fix.
  forceParsing(view, doc.length, 30_000);
  return host;
}

describe("indentation guides", () => {
  it("marks the indented lines when the preference is on", () => {
    const el = mount(INDENTED, editorPrefExtensions({ ...BASE, indentGuides: true }));
    expect(el.querySelectorAll(".cm-indent-markers").length).toBeGreaterThan(0);
  });

  it("draws nothing at all when it is off", () => {
    const el = mount(INDENTED, editorPrefExtensions({ ...BASE, indentGuides: false }));
    expect(el.querySelectorAll(".cm-indent-markers")).toHaveLength(0);
  });

  it("gives the block the cursor is in its own colour", () => {
    const el = mount(INDENTED, editorPrefExtensions({ ...BASE, indentGuides: true }), INSIDE_DEEP);
    const styles = [...el.querySelectorAll(".cm-indent-markers")].map((n) => n.getAttribute("style") ?? "");
    // The package paints the guides as one gradient per level, each reading a
    // custom property. The active block's level reads a different one, which is
    // the whole of "the active guide is distinct" at the DOM level.
    expect(styles.some((s) => s.includes("--indent-marker-active-bg-color"))).toBe(true);
    expect(styles.some((s) => s.includes("--indent-marker-bg-color"))).toBe(true);
  });

  // No test here that the colours are `var(--border-*)` rather than literals:
  // `check-tokens.mjs` fails the build on a colour literal in `editorPrefs.ts`,
  // and asserting it again against the globally-injected stylesheet would only
  // restate that guard more weakly.
});

describe("rainbow brackets", () => {
  const NESTED = "call(a, [b, {c: 1}])";

  it("gives each depth its own colour, cycling back at the fourth", async () => {
    const el = mount(NESTED, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, rainbowBrackets: true }),
    ]);
    // Three pairs, two glyphs each, at depths 0, 1 and 2.
    for (const depth of [0, 1, 2]) {
      expect(el.querySelectorAll(`.cm-bracket-depth-${depth}`), `depth ${depth}`).toHaveLength(2);
    }
    const colours = [0, 1, 2].map(
      (d) => el.querySelector(`.cm-bracket-depth-${d}`)?.getAttribute("style") ?? "",
    );
    expect(new Set(colours).size).toBe(3);
  });

  it("leaves the buffer alone when the key is off", async () => {
    const el = mount(NESTED, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, rainbowBrackets: false }),
    ]);
    expect(el.querySelectorAll('[class*="cm-bracket-depth"]')).toHaveLength(0);
  });

  it("paints the glyph itself, rather than wrapping something that paints it grey", async () => {
    // The whole feature turns on this and nothing else. Overlapping mark
    // decorations become nested spans and only the *innermost* one colours the
    // text, so a depth mark on the outside is correct, present, and invisible -
    // which reads as the setting doing nothing. The app's real highlight style
    // gives brackets the punctuation colour, so there is always an inner
    // candidate to lose to; a style that ignores brackets (CodeMirror's own
    // default) hides this entirely, which is how it shipped.
    const punctuation = HighlightStyle.define([
      { tag: [t.punctuation, t.bracket, t.paren, t.brace, t.squareBracket], color: "#808080" },
    ]);
    const el = mount(NESTED, [
      await langForPath("/repo/a.ts"),
      syntaxHighlighting(punctuation),
      editorPrefExtensions({ ...BASE, rainbowBrackets: true }),
    ]);

    const marks = el.querySelectorAll('[class*="cm-bracket-depth"]');
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      // Innermost: the bracket glyph is this element's own text, not a child's.
      expect(mark.children, `${mark.className} wraps another span`).toHaveLength(0);
      expect(mark.textContent).toMatch(/^[[\]{}()]$/);
    }
  });
});

describe("bracket pair guides", () => {
  const BLOCK = "function f() {\n  if (a) {\n    g()\n  }\n}";

  it("marks every line a multi-line pair runs through", async () => {
    const el = mount(BLOCK, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, bracketPairGuides: true }),
    ]);
    // Lines 2 to 5 sit under the outer body; line 1 opens it and gets nothing.
    const guided = el.querySelectorAll(".cm-bracket-guides");
    expect(guided).toHaveLength(4);
    expect(guided[0].getAttribute("style")).toContain("--bracket-guides:");
  });

  it("draws each pair's line in that pair's own colour", async () => {
    const el = mount(BLOCK, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, bracketPairGuides: true, rainbowBrackets: true }),
    ]);
    const inner = [...el.querySelectorAll(".cm-bracket-guides")].find((n) =>
      (n.getAttribute("style") ?? "").includes(DEPTH_COLORS[1]),
    );
    // The line inside both blocks carries the outer pair's colour and the inner
    // pair's, which are the same two the brackets themselves are painted with.
    const style = inner?.getAttribute("style") ?? "";
    expect(style).toContain(DEPTH_COLORS[0]);
    expect(style).toContain(DEPTH_COLORS[1]);
    const openBracket = el.querySelector(".cm-bracket-depth-1")?.getAttribute("style") ?? "";
    expect(openBracket).toContain(DEPTH_COLORS[1]);
  });

  it("draws nothing when the key is off", async () => {
    const el = mount(BLOCK, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, bracketPairGuides: false }),
    ]);
    expect(el.querySelectorAll(".cm-bracket-guides")).toHaveLength(0);
  });
});

describe("the minimap", () => {
  const FILE = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i}`).join("\n");

  it("draws into a container the app can reach", () => {
    const el = mount(FILE, editorPrefExtensions({ ...BASE, minimap: true }));
    const container = el.querySelector(`.${MINIMAP_CLASS}`);
    expect(container).toBeTruthy();
    // The package turns our element into its gutter, which is what the App.css
    // rules hang off: they are written one class longer than its own.
    expect(container?.classList.contains("cm-minimap-gutter")).toBe(true);
  });

  it("is absent when the key is off", () => {
    const el = mount(FILE, editorPrefExtensions({ ...BASE, minimap: false }));
    expect(el.querySelectorAll(`.${MINIMAP_CLASS}`)).toHaveLength(0);
  });

  it("lives inside the editor's own scroller, after the text", () => {
    // Where it sits is what settles the overlap question, and jsdom can answer
    // that even though it cannot measure a pixel. Inside the scroller, it is
    // clipped by the editor pane and cannot reach the panel beside it; after the
    // content, it is on the opposite side from the diff and blame gutters, which
    // CodeMirror inserts before it.
    const el = mount(FILE, [gutter({ class: "cm-diff-gutter" }), editorPrefExtensions({ ...BASE, minimap: true })]);
    const scroller = el.querySelector(".cm-scroller")!;
    const minimap = el.querySelector(`.${MINIMAP_CLASS}`)!;
    const content = scroller.querySelector(".cm-content")!;
    const gutters = scroller.querySelector(".cm-gutters")!;

    expect(minimap.parentElement).toBe(scroller);
    const order = [...scroller.children];
    expect(order.indexOf(minimap)).toBeGreaterThan(order.indexOf(content));
    expect(order.indexOf(gutters)).toBeLessThan(order.indexOf(content));
  });

  it("appears and disappears on a reconfigure, leaving the buffer alone", () => {
    // The toggle path for real: the pane holds the preferences in a compartment
    // and reconfigures it, so this must not need a new state or a reload.
    const conf = new Compartment();
    const el = mount(FILE, [conf.of(editorPrefExtensions({ ...BASE, minimap: false }))]);
    const editor = view!;
    expect(el.querySelectorAll(`.${MINIMAP_CLASS}`)).toHaveLength(0);

    editor.dispatch({
      effects: conf.reconfigure(editorPrefExtensions({ ...BASE, minimap: true })),
    });
    expect(el.querySelectorAll(`.${MINIMAP_CLASS}`)).toHaveLength(1);
    expect(editor.state.sliceDoc(), "the document never moved").toBe(FILE);

    editor.dispatch({
      effects: conf.reconfigure(editorPrefExtensions({ ...BASE, minimap: false })),
    });
    expect(el.querySelectorAll(`.${MINIMAP_CLASS}`)).toHaveLength(0);
    expect(editor.state.sliceDoc()).toBe(FILE);
  });
});

describe("sticky scroll", () => {
  const NESTED = `class Widget {\n  render() {\n    for (const c of this.cs) {\n      c.draw()\n    }\n  }\n}\n`;

  /** jsdom measures nothing, so the overlay's own idea of the top visible line
   *  is always the top of the document. Standing in for the scroll is what lets
   *  the rows be asserted at all; where they land on screen is not a question
   *  this environment can answer, and is not asked here.
   *
   *  The plugin defers its read to a measure phase, because layout may not be
   *  read during an update. `measure()` runs the pending ones now; it is
   *  CodeMirror's own flush and is not in the published types, which is worth a
   *  cast here rather than an animation frame this suite would have to wait on
   *  and could miss. */
  function scrollTo(pos: number) {
    view!.posAtCoords = () => pos;
    view!.scrollDOM.dispatchEvent(new Event("scroll"));
    (view as unknown as { measure(): void }).measure();
  }

  it("mounts nothing at all when the key is off", async () => {
    // The whole of the gate: off means the plugin is never in the
    // configuration, so no container exists, nothing listens for a scroll, and
    // no walk of the syntax tree is ever made.
    const el = mount(NESTED, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, stickyScroll: false }),
    ]);
    expect(el.querySelectorAll(`.${STICKY_CLASS}`)).toHaveLength(0);
  });

  it("mounts an overlay when the key is on, empty at the top of a file", async () => {
    const el = mount(NESTED, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, stickyScroll: true }),
    ]);
    const overlay = el.querySelector(`.${STICKY_CLASS}`);
    expect(overlay).toBeTruthy();
    // Nothing has scrolled away yet, and the CSS hides an empty container so
    // this is not a bare border across the top of an unscrolled file.
    expect(overlay?.children).toHaveLength(0);
  });

  it("pins a row per enclosing scope once they have scrolled away", async () => {
    const el = mount(NESTED, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, stickyScroll: true }),
    ]);
    scrollTo(view!.state.doc.line(4).from);
    const rows = [...el.querySelectorAll(`.${STICKY_ROW_CLASS}`)];
    expect(rows.map((r) => r.textContent)).toEqual([
      "class Widget {",
      "  render() {",
      "    for (const c of this.cs) {",
    ]);
  });

  it("asks to scroll to a row's own line when it is clicked", async () => {
    const scrolled: number[] = [];
    const el = mount(NESTED, [
      await langForPath("/repo/a.ts"),
      editorPrefExtensions({ ...BASE, stickyScroll: true }),
      // A view listener cannot see a scroll effect, so the transaction is read
      // on its way past instead.
      EditorState.transactionExtender.of((tr) => {
        for (const e of tr.effects) {
          const range = (e.value as { range?: { head?: number } } | undefined)?.range;
          if (range?.head !== undefined) scrolled.push(range.head);
        }
        return null;
      }),
    ]);
    scrollTo(view!.state.doc.line(4).from);
    const before = view!.state.selection.main.head;
    (el.querySelector(`.${STICKY_ROW_CLASS}`) as HTMLElement).click();
    expect(scrolled).toEqual([view!.state.doc.line(1).from]);
    // Looking somewhere is not going there: the caret stays where the reader
    // was actually working.
    expect(view!.state.selection.main.head).toBe(before);
  });

  it("takes its overlay away again on a reconfigure", () => {
    const conf = new Compartment();
    const el = mount(NESTED, [conf.of(editorPrefExtensions({ ...BASE, stickyScroll: true }))]);
    expect(el.querySelectorAll(`.${STICKY_CLASS}`)).toHaveLength(1);
    view!.dispatch({ effects: conf.reconfigure(editorPrefExtensions({ ...BASE, stickyScroll: false })) });
    // The container lives in the editor's DOM rather than in a decoration, so
    // turning the key off has to remove it by hand; a leak here would leave a
    // dead overlay pinned over the file.
    expect(el.querySelectorAll(`.${STICKY_CLASS}`)).toHaveLength(0);
  });
});

describe("css colour swatches", () => {
  it("puts a swatch beside a colour literal in a css buffer", async () => {
    const el = mount("a { color: #ff0000; }", await langForPath("/repo/a.css"));
    expect(el.querySelectorAll(".cm-css-color-picker-wrapper")).toHaveLength(1);
    expect(el.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe("#ff0000");
  });

  it("leaves the same literal alone in a buffer that is not css", async () => {
    // The picker reads the CSS syntax tree, so pairing it with the CSS pack is
    // what keeps it out of every other language rather than a check at runtime.
    const el = mount('const red = "#ff0000";', await langForPath("/repo/a.ts"));
    expect(el.querySelectorAll(".cm-css-color-picker-wrapper")).toHaveLength(0);
    expect(el.querySelectorAll('input[type="color"]')).toHaveLength(0);
  });

  it("finds every literal in the buffer, not just the first", async () => {
    const el = mount("a { color: #ff0000; background: #00ff00; }", await langForPath("/repo/a.css"));
    expect(el.querySelectorAll('input[type="color"]')).toHaveLength(2);
  });
});
