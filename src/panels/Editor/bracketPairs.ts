// Bracket pairs, coloured by how deep they are nested, and the vertical line
// that links a pair's two halves.
//
// Both features are one pass over the same thing: the delimited nodes of the
// syntax tree inside the viewport. A pair is found as a *node* whose first and
// last characters are matching brackets, rather than by hunting for bracket
// tokens, which buys three things at once. Brackets inside strings and comments
// are excluded for free, because they delimit nothing. An open and its close
// always agree on a colour, because the depth is a property of the node they
// share rather than of a counter that happened to be running. And the pass is
// bounded by the viewport with no loss of accuracy: `iterate({from, to})`
// descends from the root, so every enclosing node is still entered and the depth
// at the top of the screen is the true one, with no scan back to the start of
// the file.
//
// The community `rainbowbrackets` package was rejected in this wave's package
// audit (last published 2023, and it depends on `@codemirror/view` rather than
// peering it, which invites a second copy of CM6 and breaks facet identity).

import { syntaxTree } from "@codemirror/language";
import { countColumn, Prec, type EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

const OPEN = "([{";
const CLOSE = ")]}";

/**
 * The depth ramp, cycled.
 *
 * Scale roles rather than the `--syntax-*` ones: a syntax role means "this is a
 * keyword", and spending it on "this is two levels deep" would make two
 * different things the same colour. The scale family exists precisely to be a
 * set of hues with no meaning attached, and the contrast gate already holds
 * every one of them to the graphic floor against `canvas.card`, which is the
 * editor's own background (`CONTRAST_RULES` in `src/theme/contrast.ts`).
 *
 * Three, in VS Code's order, because they stay far apart in hue in every
 * bundled palette; depth 3 starting the cycle again is what that editor does
 * too, and by then the nesting itself is the problem.
 */
export const DEPTH_COLORS = ["var(--scale-yellow)", "var(--scale-purple)", "var(--scale-blue)"] as const;

/** CodeMirror's own `.cm-line` padding-left. The guides are drawn as a shadow
 *  cast by a pseudo-element at the line's border edge, so the offsets have to
 *  clear the padding before the first character starts. */
const LINE_PADDING = "6px";

export type BracketPair = {
  /** Position of the opening bracket. */
  from: number;
  /** Position just past the closing bracket. */
  to: number;
  /** Nesting depth, 0 for an outermost pair. Not yet reduced onto the ramp. */
  depth: number;
};

/** Whether the text spanning `from` to `to` opens and closes with a matching
 *  pair of brackets, which is what makes a node a bracket pair. */
function delimited(state: EditorState, from: number, to: number): boolean {
  if (to - from < 2) return false;
  const kind = OPEN.indexOf(state.doc.sliceString(from, from + 1));
  return kind >= 0 && state.doc.sliceString(to - 1, to) === CLOSE[kind];
}

/**
 * Every bracket pair overlapping `ranges`, outermost first, with its true
 * nesting depth.
 *
 * `ranges` is the view's visible ranges. A pair that merely spans the viewport
 * is included, since its guide line runs through the screen even when neither
 * of its brackets is on it.
 */
/**
 * One walk per (state, viewport), so the two features share a pass rather than
 * each taking their own. Keyed on the state, which a transaction replaces, and
 * on the ranges, which scrolling replaces: either moving is exactly when the
 * answer changes. A `WeakMap`, so a buffer the user closed takes its entry with
 * it.
 */
const walked = new WeakMap<EditorState, { key: string; pairs: BracketPair[] }>();

export function visiblePairs(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): BracketPair[] {
  const key = ranges.map((r) => `${r.from}:${r.to}`).join(",");
  const cached = walked.get(state);
  if (cached?.key === key) return cached.pairs;
  const pairs = walkPairs(state, ranges);
  walked.set(state, { key, pairs });
  return pairs;
}

function walkPairs(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): BracketPair[] {
  const tree = syntaxTree(state);
  const pairs: BracketPair[] = [];
  const seen = new Set<number>();
  for (const { from, to } of ranges) {
    let depth = 0;
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (!delimited(state, node.from, node.to)) return;
        // Ranges are visited in order but two of them can share an enclosing
        // pair, and that pair is entered once per range.
        if (!seen.has(node.from)) {
          seen.add(node.from);
          pairs.push({ from: node.from, to: node.to, depth });
        }
        depth++;
      },
      leave: (node) => {
        if (delimited(state, node.from, node.to)) depth--;
      },
    });
  }
  return pairs;
}

export type LineGuide = {
  /** 1-based line number the guide is drawn on. */
  line: number;
  /** Column the vertical line sits at, from the pair's opening line. */
  column: number;
  /** The pair's depth, for the colour. */
  depth: number;
};

/**
 * Where to draw a vertical line so a pair's two halves are visibly one pair.
 *
 * One entry per line the pair covers below its opening line, down to and
 * including the closing one, at the indentation the pair opened at, which is
 * where the eye is already looking for the block's left edge. A pair that opens
 * and closes on one line gets nothing: the two brackets are already side by
 * side, and a line between them would have nowhere to go.
 */
export function pairGuides(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): LineGuide[] {
  const guides: LineGuide[] = [];
  for (const pair of visiblePairs(state, ranges)) {
    const open = state.doc.lineAt(pair.from);
    const close = state.doc.lineAt(pair.to);
    if (close.number <= open.number) continue;
    const indent = /^\s*/.exec(open.text)?.[0] ?? "";
    const column = countColumn(indent, state.tabSize);
    for (const { from, to } of ranges) {
      const first = Math.max(open.number + 1, state.doc.lineAt(from).number);
      const last = Math.min(close.number, state.doc.lineAt(to).number);
      for (let line = first; line <= last; line++) guides.push({ line, column, depth: pair.depth });
    }
  }
  return guides;
}

const marks = DEPTH_COLORS.map((color, depth) =>
  // The colour rides as an inline style rather than as a class rule, so it
  // cannot lose a specificity argument with the syntax highlighter, which is
  // already colouring these same characters as punctuation.
  Decoration.mark({ class: `cm-bracket-depth-${depth}`, attributes: { style: `color: ${color}` } }),
);

const colorOf = (depth: number) => marks[depth % marks.length];

function bracketMarks(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const onScreen = (pos: number) =>
    view.visibleRanges.some((r) => pos >= r.from && pos < r.to);
  for (const pair of visiblePairs(view.state, view.visibleRanges)) {
    const mark = colorOf(pair.depth);
    // A pair enclosing the viewport belongs to the pass (its guide crosses the
    // screen) but its own glyphs can be thousands of lines away, and a
    // decoration there is one CodeMirror will only throw away.
    if (onScreen(pair.from)) ranges.push(mark.range(pair.from, pair.from + 1));
    if (onScreen(pair.to - 1)) ranges.push(mark.range(pair.to - 1, pair.to));
  }
  // Nesting produces them outermost-first rather than in document order.
  return Decoration.set(ranges, true);
}

/** One line decoration per guided line, carrying every guide crossing it as a
 *  shadow offset. One pseudo-element can cast many shadows, which is what lets
 *  several nested pairs draw through the same line. */
function guideLines(view: EditorView): DecorationSet {
  const byLine = new Map<number, LineGuide[]>();
  for (const guide of pairGuides(view.state, view.visibleRanges)) {
    const on = byLine.get(guide.line);
    if (on) on.push(guide);
    else byLine.set(guide.line, [guide]);
  }
  const ranges: Range<Decoration>[] = [];
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const shadows = byLine
      .get(line)!
      .map((g) => `calc(${LINE_PADDING} + ${g.column}ch) 0 0 0 ${DEPTH_COLORS[g.depth % DEPTH_COLORS.length]}`)
      .join(", ");
    ranges.push(
      Decoration.line({
        class: "cm-bracket-guides",
        attributes: { style: `--bracket-guides: ${shadows}` },
      }).range(view.state.doc.line(line).from),
    );
  }
  return Decoration.set(ranges);
}

const guideTheme = EditorView.baseTheme({
  ".cm-bracket-guides": { position: "relative" },
  ".cm-bracket-guides::before": {
    content: '""',
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: "1px",
    // The element itself is invisible; every guide on the line is one shadow it
    // casts, so a line inside three nested pairs still needs only this one.
    boxShadow: "var(--bracket-guides)",
    pointerEvents: "none",
  },
});

/** Rebuild when the text, the viewport, or the parse moved. The third matters
 *  on its own: a large file finishes parsing in the background, and pairs the
 *  tree did not know about yet are still uncoloured until it does. */
const rebuilds = (u: ViewUpdate) =>
  u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state);

function pass(build: (view: EditorView) => DecorationSet) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (rebuilds(u)) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Colour each bracket by how deeply it is nested.
 *
 * `Prec.highest` is load-bearing, and the reasoning runs the opposite way to
 * the intuition (the same trap `semanticHighlight.ts` documents). Overlapping
 * mark decorations become nested spans, and the *innermost* element is the one
 * whose `color` paints the glyph - an outer element's inline style never enters
 * into it. `@codemirror/language` registers `treeHighlighter` at `Prec.high`,
 * and `swayHighlight` gives `t.bracket`/`t.paren`/`t.brace` the punctuation
 * colour, so at default precedence every depth colour is wrapped *around* a
 * grey span and none of it is ever seen.
 *
 * It looks exactly like the feature being switched off, which is why it went
 * unnoticed: the decorations are all there, correct, and invisible.
 */
export const rainbowBrackets = () => Prec.highest(pass(bracketMarks));

/** Link each multi-line pair's halves with a vertical line in the pair's own
 *  colour. */
export const bracketPairGuides = () => [pass(guideLines), guideTheme];
