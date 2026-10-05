// The bracket pass, and the ramp it paints with.
//
// Finding the pairs and deciding their depth is a question about an
// EditorState, and the ramp is a question about the palettes. What a decoration
// looks like on screen is not something jsdom can answer, so it is not asked
// here - but the state still has to be built behind a view, because a view is
// the only thing that finishes the parse. See `stateFor`.
import { describe, it, expect, afterEach } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import toriDark from "../../theme/palettes/tori-dark.json";
import toriLight from "../../theme/palettes/tori-light.json";
import catppuccin from "../../theme/palettes/catppuccin-mocha.json";
import rosePine from "../../theme/palettes/rose-pine-dawn.json";
import tokyoNight from "../../theme/palettes/tokyo-night.json";
import { buildRoles } from "../../theme/roles";
import { GRAPHIC_MIN, parseColor, ratioOn } from "../../theme/contrast";
import type { Palette } from "../../theme/schema";
import { DEPTH_COLORS, visiblePairs, pairGuides } from "./bracketPairs";

const CODE = `function outer() {
  if (a) {
    call([1, 2])
  }
}`;

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/**
 * A parsed state. The view is here for the parse, not for the DOM.
 *
 * `EditorState.create` runs the language field's first parse under a **25ms
 * budget** into a 3000-character viewport, and on a state with no view nothing
 * ever advances it after that: applying transactions does not, and
 * `ensureSyntaxTree` returns a fuller tree to its caller while leaving the
 * field's own tree exactly as short as it was, which is what `syntaxTree` -
 * and therefore `visiblePairs` - reads.
 *
 * That budget is wall-clock, so on a loaded machine it expires early. Measured
 * with `Date.now` stubbed to run fast: the tree for the 4000-line document
 * below comes back **9 characters** long, `visiblePairs` finds nothing over a
 * window at character 1069, and the assertion fails as `expected 0 to be
 * greater than 0` - on CI, never here. That is gettori/tori#121's red run and
 * two red runs on main before it.
 *
 * A view is what fixes it: it owns the background parse worker, and
 * `forceParsing` drives it to completion synchronously. The app was never
 * affected, because the real editor has one and re-runs the pass as parsing
 * advances (`bracketPairs.ts:239`).
 */
function stateFor(doc: string): EditorState {
  const view = new EditorView({ doc, extensions: [javascript()], parent: document.body });
  views.push(view);
  forceParsing(view, doc.length, 30_000);
  return view.state;
}

/** Every pair in the whole document, as the bracket kind plus its depth. */
function pairsOf(doc: string, ranges?: { from: number; to: number }[]) {
  const state = stateFor(doc);
  return visiblePairs(state, ranges ?? [{ from: 0, to: doc.length }]).map((p) => ({
    open: doc.slice(p.from, p.from + 1),
    close: doc.slice(p.to - 1, p.to),
    depth: p.depth,
    line: state.doc.lineAt(p.from).number,
  }));
}

describe("finding the pairs", () => {
  it("gives every pair the depth it is actually nested at", () => {
    expect(pairsOf(CODE)).toEqual([
      // The parameter list and the body are both outermost: the function
      // declaration around them opens with a letter, not a bracket.
      { open: "(", close: ")", depth: 0, line: 1 },
      { open: "{", close: "}", depth: 0, line: 1 },
      { open: "(", close: ")", depth: 1, line: 2 },
      { open: "{", close: "}", depth: 1, line: 2 },
      { open: "(", close: ")", depth: 2, line: 3 },
      { open: "[", close: "]", depth: 3, line: 3 },
    ]);
  });

  it("pairs an opening bracket only with its own kind of closer", () => {
    // `(1, 2]` is not a pair, whatever the grammar makes of it.
    for (const p of pairsOf("f([1], (2), {x: 3})")) {
      expect(`${p.open}${p.close}`, `${p.open}…${p.close}`).toMatch(/^(\(\)|\[\]|\{\})$/);
    }
  });

  it("ignores brackets that punctuate nothing", () => {
    // Inside a string or a comment a bracket delimits no node, so the pass
    // never sees it. That falls out of reading the tree rather than the text,
    // which is the reason for reading the tree.
    expect(pairsOf('const s = "a (b) c"')).toEqual([]);
    expect(pairsOf("// a (b) c")).toEqual([]);
  });

  it("walks once for a given buffer and viewport, however many features ask", () => {
    // Both toggles resolve to their own view plugin, and both call this on the
    // same update. The second call is the same answer, not a second walk.
    const state = stateFor(CODE);
    const ranges = [{ from: 0, to: CODE.length }];
    expect(visiblePairs(state, ranges)).toBe(visiblePairs(state, [...ranges]));
    // Scrolling changes the question, so it is asked again.
    expect(visiblePairs(state, [{ from: 0, to: 10 }])).not.toBe(visiblePairs(state, ranges));
  });

  it("counts a pair once even when two visible ranges share it", () => {
    // A fold or a block widget splits the viewport, and the enclosing pair
    // overlaps both halves.
    const ranges = [
      { from: 0, to: CODE.indexOf("if") },
      { from: CODE.indexOf("call"), to: CODE.length },
    ];
    const outerBlocks = pairsOf(CODE, ranges).filter((p) => p.open === "{" && p.depth === 0);
    expect(outerBlocks).toHaveLength(1);
  });
});

describe("staying inside the viewport", () => {
  // 4000 lines of two-deep nesting, which is the shape the plan's ">5k-line
  // file scrolls without lag" verify is really about: the pass has to cost the
  // window, not the file.
  const BIG = Array.from({ length: 2000 }, (_, i) => `function f${i}() {\n  g([${i}])\n}`).join("\n");

  it("returns the pairs the window can see, and no more", () => {
    const state = stateFor(BIG);
    const window = { from: state.doc.line(100).from, to: state.doc.line(112).to };
    const pairs = visiblePairs(state, [window]);

    expect(pairs.length).toBeGreaterThan(0);
    // Nothing outside the window, and nothing enclosing it either: at this
    // nesting there is no pair spanning the whole file.
    for (const p of pairs) {
      expect(p.from, "starts before the window").toBeLessThan(window.to);
      expect(p.to, "ends after the window").toBeGreaterThan(window.from);
    }
  });

  it("costs the window rather than the file", () => {
    const small = stateFor(BIG.split("\n").slice(0, 300).join("\n"));
    const big = stateFor(BIG);
    const window = (s: EditorState) => [{ from: s.doc.line(50).from, to: s.doc.line(62).to }];

    // The same window over a file six times longer finds the same pairs. A pass
    // that walked the document instead would grow with it.
    expect(visiblePairs(big, window(big))).toHaveLength(visiblePairs(small, window(small)).length);
  });

  it("still knows the true depth at the top of the screen", () => {
    // The window starts inside a block whose opening brace is far above it, so
    // a counter that began at the top of the viewport would call this depth 0.
    const doc = `outer(\n${"  filler(0),\n".repeat(50)}  inner([1]),\n)`;
    const state = stateFor(doc);
    const line = state.doc.line(52);
    const pairs = visiblePairs(state, [{ from: line.from, to: line.to }]);
    const array = pairs.find((p) => doc.slice(p.from, p.from + 1) === "[");
    expect(array?.depth).toBe(2);
  });
});

describe("the guide lines", () => {
  const all = (doc: string) => pairGuides(stateFor(doc), [{ from: 0, to: doc.length }]);

  it("runs from under the opening line down to the closing one", () => {
    const guides = all(CODE).filter((g) => g.depth === 0 && g.column === 0);
    // The outer body opens on line 1 and closes on line 5.
    expect(guides.map((g) => g.line)).toEqual([2, 3, 4, 5]);
  });

  it("sits at the indentation the pair opened at", () => {
    const inner = all(CODE).filter((g) => g.depth === 1);
    // `if (a) {` is indented two spaces, so its guide is two columns in.
    expect(new Set(inner.map((g) => g.column))).toEqual(new Set([2]));
  });

  it("draws nothing for a pair that opens and closes on one line", () => {
    expect(all("call([1, 2])")).toEqual([]);
  });

  it("gives a line one entry per pair crossing it", () => {
    // Line 3 is inside both blocks, so it carries two guides at two columns.
    expect(all(CODE).filter((g) => g.line === 3)).toHaveLength(2);
  });
});

describe("the depth ramp", () => {
  const PALETTES: [string, Palette][] = [
    ["tori-dark", toriDark as Palette],
    ["tori-light", toriLight as Palette],
    ["catppuccin-mocha", catppuccin as Palette],
    ["rose-pine-dawn", rosePine as Palette],
    ["tokyo-night", tokyoNight as Palette],
  ];

  /** `var(--scale-yellow)` back to the role name the palette resolves. */
  const roleOf = (color: string) => color.replace(/^var\(|\)$/g, "");

  it("names roles the theme actually declares", () => {
    const built = buildRoles(toriDark as Palette);
    for (const color of DEPTH_COLORS) expect(built, color).toHaveProperty(roleOf(color));
  });

  it.each(PALETTES)("%s keeps every depth legible on the editor's own background", (_id, palette) => {
    const built = buildRoles(palette);
    const background = built["--canvas-card"];
    for (const color of DEPTH_COLORS) {
      const ratio = ratioOn(built[roleOf(color)], background);
      // The graphic floor, which is the tier `syntax.punctuation` already sits
      // at: a bracket is punctuation, and colouring it by depth does not make it
      // body text.
      expect(ratio, `${color} on the editor background`).toBeGreaterThanOrEqual(GRAPHIC_MIN);
    }
  });

  /** Hue angle, in degrees. Distance in RGB is the wrong question here: a
   *  palette can pitch two hues at almost the same lightness and saturation
   *  (every pastel theme does) and they are still told apart at a glance,
   *  because what the eye reads on a one-character glyph is the hue. */
  function hue([r, g, b]: [number, number, number]): number {
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma === 0) return 0;
    const h = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    return (h * 60 + 360) % 360;
  }

  const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

  it.each(PALETTES)("%s keeps adjacent depths apart", (_id, palette) => {
    const built = buildRoles(palette);
    const hues = DEPTH_COLORS.map((c) => {
      const parsed = parseColor(built[roleOf(c)]);
      expect(parsed, c).toBeTruthy();
      return hue(parsed!.rgb);
    });
    // Every neighbour in the cycle, the wrap from the last back to the first
    // included, since depth 3 starts the ramp again.
    for (let i = 0; i < hues.length; i++) {
      const gap = apart(hues[i], hues[(i + 1) % hues.length]);
      // Tokyo Night's lavender and periwinkle are the tightest pair any bundled
      // palette produces, at 41 degrees. The floor sits just under that: it is a
      // guard against a future ramp or palette collapsing two depths into one
      // hue, not a claim that 35 degrees is the threshold of perception.
      expect(gap, `${DEPTH_COLORS[i]} vs ${DEPTH_COLORS[(i + 1) % hues.length]}`).toBeGreaterThan(35);
    }
  });
});
