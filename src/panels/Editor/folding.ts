// Folding: which lines offer a fold, and the chevron that says so.
//
// CodeMirror's own answer to "can this line fold" is the grammar's fold props
// and nothing else, and that leaves holes. lezer-javascript folds blocks, object
// and array literals, class and switch bodies and block comments, and stops: an
// argument list broken over five lines, a multi-line import list, a run of `//`
// lines all get no marker. A shell script or a .toml is worse, because
// `StreamLanguage` carries no fold information at all. A buffer with no language
// at all (a .env, a log, a Dockerfile) is worse again, and has never had a single
// fold marker in it. VS Code folds every one of those, which is the bar this file
// is written against.
//
// Three sources, tried in that order, first answer wins:
//
//   1. the grammar, unchanged: re-probed here rather than deferred to, for the
//      reason written on `syntaxFold`;
//   2. comment runs, which no grammar we load has an opinion about at all;
//   3. indentation, the fallback for everything left.
//
// Indentation coming last is the whole point of the ordering. `stickyScroll.ts`
// refuses to derive scopes from whitespace and says so in its header, and it is
// right to: a pinned row has to *name* the scope it stands for, and indentation
// does not know a name. A fold marker makes no such claim. It says "the lines
// under this one are further in than it is", which is the one thing indentation
// does know, and it is what every editor falls back to when the grammar is
// silent. Where the grammar does speak, it still wins.
//
// Editor-side, behind the lazy boundary: it imports CodeMirror.

import { foldGutter, foldNodeProp, foldService, syntaxTree } from "@codemirror/language";
import { countColumn, type EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { NodeIterator, SyntaxNode } from "@lezer/common";

/** What a fold service returns: the range hidden when the line is folded. */
type FoldRange = { from: number; to: number };

/**
 * How many lines a scan walks before giving up and offering no fold.
 *
 * Both fallbacks answer "where does this run of lines end" by walking forward,
 * and the walk is per viewport line on every gutter rebuild, so an unbounded one
 * is a scroll that stutters on a 200k-line file. Giving up means no marker on
 * that line, never a range that stops short: a fold that hides the wrong lines
 * is worse than a fold that is not offered.
 */
const MAX_SCAN = 10_000;

const SVG_NS = "http://www.w3.org/2000/svg";
// Lucide's chevron-down and chevron-right, drawn by hand for codeActionBulb.ts's
// reason: this module sits behind the lazy editor edge and builds its DOM
// without Solid, so it cannot render `lucide-solid`.
const CHEVRON_DOWN = "m6 9 6 6 6-6";
const CHEVRON_RIGHT = "m9 18 6-6-6-6";

// Literal class strings on CodeMirror's own gutter DOM, so styled in App.css
// beside the other gutters rather than in a CSS module.
const FOLD_MARKER_CLASS = "cm-fold-marker";
const FOLD_OPEN_CLASS = "cm-fold-open";
const FOLD_CLOSED_CLASS = "cm-fold-closed";
const FOLD_HOVER_CLASS = "cm-fold-hover";

/**
 * Whether the grammar already folds this line.
 *
 * This is `syntaxFolding` from @codemirror/language, which is not exported. It
 * has to be repeated rather than called because of how `foldable` is wired: it
 * asks every `foldService` first and only falls through to the grammar when all
 * of them return null. A service is therefore an override, not a fallback, and
 * the only way to stay a fallback is to answer the grammar's question ourselves
 * and stand down when it has one.
 *
 * Kept line for line with the original, including the half-parsed guard: a probe
 * that drifts from the thing it is probing produces folds that disagree with the
 * ones CodeMirror then makes.
 */
function syntaxFold(state: EditorState, start: number, end: number): FoldRange | null {
  const tree = syntaxTree(state);
  if (tree.length < end) return null;
  let found: FoldRange | null = null;
  for (let iter: NodeIterator | null = tree.resolveStack(end, 1); iter; iter = iter.next) {
    const cur = iter.node;
    if (cur.to <= end || cur.from > end) continue;
    if (found && cur.from < start) break;
    const prop = cur.type.prop(foldNodeProp);
    if (!prop) continue;
    // Past the parsed edge a node's tail is whatever the parser had reached, and
    // folding to it would hide a range the next parse redraws.
    if (!(cur.to < tree.length - 50 || tree.length === state.doc.length || !unfinished(cur))) continue;
    const value = prop(cur, state);
    if (value && value.from <= end && value.from >= start && value.to > end) found = value;
  }
  return found;
}

function unfinished(node: SyntaxNode): boolean {
  const last = node.lastChild;
  return !!last && last.to === node.to && last.type.isError;
}

/** The line's indentation in columns, or null when it holds nothing but space:
 *  a blank line has no indentation of its own, it belongs to whatever block
 *  runs through it. */
function indentOf(text: string, tabSize: number): number | null {
  const first = text.search(/\S/);
  return first < 0 ? null : countColumn(text, tabSize, first);
}

/**
 * The run of lines indented further than this one.
 *
 * Trailing blank lines fall outside the range because only a line with content
 * moves the end: folding a block should not swallow the gap before whatever
 * comes next.
 */
function indentFold(state: EditorState, start: number, end: number): FoldRange | null {
  const line = state.doc.lineAt(start);
  const base = indentOf(line.text, state.tabSize);
  if (base === null) return null;
  let to = -1;
  const limit = Math.min(state.doc.lines, line.number + MAX_SCAN);
  for (let n = line.number + 1; n <= limit; n++) {
    const next = state.doc.line(n);
    const indent = indentOf(next.text, state.tabSize);
    if (indent === null) continue;
    if (indent <= base) return to > end ? { from: end, to } : null;
    to = next.to;
  }
  // Ran to the end of the document, or ran out of budget. The first is a real
  // block that happens to close the file; the second is not answerable.
  return limit === state.doc.lines && to > end ? { from: end, to } : null;
}

/**
 * A block comment that carries on past this line, or the run of single-line
 * comments this one opens.
 *
 * A block comment only ever reaches here when its own grammar stayed quiet:
 * JavaScript and Rust fold theirs and win at step one, CSS and YAML do not and
 * arrive here. A run of line comments arrives here from every language, because
 * no grammar models one: the run is a thing a reader sees, not a node.
 *
 * Only a line whose *first* non-space character starts the comment counts. A
 * comment trailing real code is a remark about that line, and a marker offering
 * to fold the lines below it would be pointing at something else entirely.
 *
 * The opening line is checked against the syntax tree, so `// not a comment`
 * sitting inside a template literal offers nothing. The lines after it are
 * matched textually against the language's own comment token, because the tree
 * is only parsed as far as the viewport and a run of comments below the fold
 * would otherwise stop at the parser's edge and fold half of itself.
 */
function commentFold(state: EditorState, start: number, end: number): FoldRange | null {
  const tree = syntaxTree(state);
  if (tree.length < end) return null;
  const line = state.doc.lineAt(start);
  const first = line.text.search(/\S/);
  if (first < 0) return null;
  const node = tree.resolveInner(line.from + first, 1);
  if (!/comment/i.test(node.name) || node.from < line.from) return null;
  if (node.to > end) return { from: end, to: node.to };

  const token = state.languageDataAt<{ line?: string }>("commentTokens", line.from)[0]?.line;
  if (!token) return null;
  let last = line;
  const limit = Math.min(state.doc.lines, line.number + MAX_SCAN);
  for (let n = line.number + 1; n <= limit; n++) {
    const next = state.doc.line(n);
    if (!next.text.trimStart().startsWith(token)) return last.to > end ? { from: end, to: last.to } : null;
    last = next;
  }
  // Same as the indentation scan: the end of the document is an answer, the end
  // of the budget is not.
  return limit === state.doc.lines && last.to > end ? { from: end, to: last.to } : null;
}

/** The grammar first, then the two things it does not cover. */
function foldRange(state: EditorState, start: number, end: number): FoldRange | null {
  if (syntaxFold(state, start, end)) return null;
  return commentFold(state, start, end) ?? indentFold(state, start, end);
}

function chevron(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = `${FOLD_MARKER_CLASS} ${open ? FOLD_OPEN_CLASS : FOLD_CLOSED_CLASS}`;
  span.title = open ? "Fold" : "Unfold";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", open ? CHEVRON_DOWN : CHEVRON_RIGHT);
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

/**
 * Whether the pointer is in the gutter, as one class on the editor's root node.
 *
 * `.cm-gutters:hover` says the same thing in a line of CSS and was the first
 * version of this, but the chevrons under it came out of a hover stuck lit,
 * some of them, until a click forced the gutter to redraw. The markers are not
 * stable DOM: CodeMirror keeps its gutter elements and recycles them onto other
 * lines as the viewport moves, so which span is under a hovered ancestor is a
 * moving target. `view.dom` is the one node in an editor that is never rebuilt.
 * Hanging the state there makes the reveal a single boolean on a fixed element,
 * and every chevron flips with it or none of them do.
 *
 * `mousemove` rather than `mouseenter` on the gutter, because the gutters are
 * built by CodeMirror and a plugin cannot count on them existing when it is
 * constructed. `closest` off the event target is a handful of parent hops on a
 * move the browser was already dispatching.
 */
const gutterHover = ViewPlugin.fromClass(
  class {
    private readonly moved = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      this.view.dom.classList.toggle(FOLD_HOVER_CLASS, !!target?.closest(".cm-gutters"));
    };
    private readonly left = () => this.view.dom.classList.remove(FOLD_HOVER_CLASS);

    constructor(readonly view: EditorView) {
      view.dom.addEventListener("mousemove", this.moved);
      view.dom.addEventListener("mouseleave", this.left);
    }

    destroy() {
      this.view.dom.removeEventListener("mousemove", this.moved);
      this.view.dom.removeEventListener("mouseleave", this.left);
    }
  },
);

/** The fold column, added to every editor buffer. */
export function foldingExtension(): Extension {
  return [foldService.of(foldRange), foldGutter({ markerDOM: chevron }), gutterHover];
}
