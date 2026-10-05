// Sticky scroll: the enclosing scopes of whatever is at the top of the screen,
// pinned over it.
//
// Reading the middle of a long method, the line that says which method it is has
// scrolled away, and so has the class, and so has the file's outermost block. A
// breadcrumb bar answers that for the *caret*; this answers it for the top of the
// viewport, which is where the eye is when you are scrolling rather than editing.
//
// The scope chain comes off the syntax tree the same way `bracketPairs.ts` finds
// its pairs, and for the same reason: the tree already knows what encloses what,
// so nothing here has to guess from indentation. Walking *up* from one position
// rather than iterating a range makes it O(nesting depth) per scroll, which is
// what lets it run on a scroll event rather than on a debounce.
//
// A grammar with no nesting to speak of (anything behind `StreamLanguage`) yields
// an empty chain, and the overlay renders nothing. That is the honest answer: the
// tree does not know where the scopes are, and inventing them from whitespace
// would be a second, disagreeing idea of what a scope is.
//
// Editor-side on purpose: this imports CodeMirror, so it sits behind the lazy
// editor boundary and must never be imported from the eager side.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * How many scopes are pinned before the overlay stops taking more.
 *
 * The deepest are dropped rather than the outermost. Every scope in the chain
 * has scrolled away, but the outer ones say *where in the file* you are, which
 * nothing else on screen does, while the innermost is a few lines up and comes
 * back the moment you scroll toward it. Five, matching VS Code, and past that
 * the overlay is eating the file it is describing.
 */
export const MAX_STICKY = 5;

/** A scope worth pinning: the line that opened it. */
export type StickyHeader = {
  /** 1-based line number, as the gutter and `@file#L<n>` speak it. */
  line: number;
  /** Start of that line, which is where a click on the row scrolls to. */
  from: number;
  /** The line as written, indentation kept: the indent is what makes a stack of
   *  rows read as a nesting rather than as a list. */
  text: string;
};

/**
 * The scopes enclosing `pos`, outermost first, that have scrolled off above it.
 *
 * Walks parents from the innermost node at `pos` up to the root, keeping every
 * ancestor whose own first line sits *above* the line `pos` is on. A scope
 * starting on that line needs no pinning, because it is on screen.
 *
 * **Deduplicated by line, which is what makes this work across grammars.** One
 * source line is routinely several nested nodes: `export default function f() {`
 * is an export, a declaration and a block, all starting at the same character.
 * Keying on the line rather than the node collapses them into the one row a
 * reader would draw, without this file needing a list of which node types count
 * as a scope in which language.
 *
 * The root is skipped: the whole document is not a scope anybody scrolled out
 * of, and pinning line 1 of every file would be a row that never changes.
 */
export function stickyHeaders(state: EditorState, pos: number, max = MAX_STICKY): StickyHeader[] {
  const topLine = state.doc.lineAt(pos).number;
  const out: StickyHeader[] = [];
  const seen = new Set<number>();
  let node = syntaxTree(state).resolveInner(pos, 1);
  // `parent` null is the root, so the loop stops one short of the document node.
  for (let up = node.parent; up; node = up, up = node.parent) {
    const line = state.doc.lineAt(node.from);
    if (line.number >= topLine || seen.has(line.number)) continue;
    // A node opening on a blank line names nothing; the row would be an empty
    // stripe over the file.
    if (!line.text.trim()) continue;
    seen.add(line.number);
    out.push({ line: line.number, from: line.from, text: line.text });
  }
  return out.reverse().slice(0, max);
}

/** Styled through `baseTheme` below. Exported because the plugin, the theme and
 *  the tests all have to agree on them. */
export const STICKY_CLASS = "cm-sticky-scroll";
export const STICKY_ROW_CLASS = "cm-sticky-row";

/**
 * The document position at the top edge of what is actually on screen.
 *
 * Measured off the DOM rather than read from `view.viewport`, which is the
 * *rendered* range: CodeMirror renders a margin above and below the visible
 * area, and for any file shorter than that margin the viewport is the whole
 * document. Sticky scroll driven by it would sit blank on exactly the files
 * people read most.
 *
 * `posAtCoords` with `precise` false always answers, clamping to the nearest
 * position, so a coordinate the editor cannot map (an environment with no
 * layout) degrades to the top of the document and an empty chain.
 *
 * **Only callable from a measure phase.** CodeMirror refuses to read layout
 * during an update, which is where a plugin's constructor and `update` both run,
 * so every caller here goes through `view.requestMeasure`.
 */
function topVisiblePos(view: EditorView): number {
  const rect = view.scrollDOM.getBoundingClientRect();
  return view.posAtCoords({ x: rect.left + 1, y: rect.top + 1 }, false);
}

/** Whether two chains would draw the same rows, so a scroll that stayed inside
 *  one scope costs no DOM work at all. This runs on every scroll event. */
function same(a: readonly StickyHeader[], b: readonly StickyHeader[]): boolean {
  return a.length === b.length && a.every((h, i) => h.line === b[i].line && h.text === b[i].text);
}

const stickyPlugin = ViewPlugin.fromClass(
  class {
    readonly dom: HTMLElement;
    private headers: StickyHeader[] = [];

    constructor(readonly view: EditorView) {
      this.dom = document.createElement("div");
      this.dom.className = STICKY_CLASS;
      // Inside `view.dom`, which does not itself scroll, so `top: 0` pins the
      // overlay over the scroller rather than riding up with the content.
      view.dom.appendChild(this.dom);
      view.scrollDOM.addEventListener("scroll", this.onScroll);
      this.schedule();
    }

    // An arrow property so removing it names the same function that was added.
    private onScroll = () => this.schedule();

    update(u: ViewUpdate) {
      // The parse moving matters on its own: a large file finishes parsing in
      // the background, and until it does the chain above the viewport is
      // shorter than it really is.
      if (u.docChanged || u.geometryChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.schedule();
      }
    }

    destroy() {
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
      this.dom.remove();
    }

    /**
     * Ask for the chain to be recomputed in the next measure phase.
     *
     * Not computed here, because the answer depends on where the viewport is,
     * and CodeMirror refuses to be asked that during an update. Keyed on the
     * plugin, so a flick of the scroll wheel that fires twenty scroll events
     * costs one read rather than twenty.
     */
    private schedule() {
      this.view.requestMeasure({
        key: this,
        read: (view) => ({
          headers: stickyHeaders(view.state, topVisiblePos(view)),
          // Where the text starts, past the gutters. Read here because this is
          // the phase allowed to ask.
          left: view.contentDOM.getBoundingClientRect().left - view.dom.getBoundingClientRect().left,
        }),
        write: ({ headers, left }) => this.draw(headers, left),
      });
    }

    private draw(next: StickyHeader[], left: number) {
      // Lined up with the text rather than with the editor's left edge: the
      // gutters sit between the two, and a header indented from the wrong origin
      // does not stack over the code it was lifted from. Applied before the
      // early return below, since the gutters can widen (a four-digit line
      // number) while the chain stays exactly the same.
      this.dom.style.left = `${left}px`;
      if (same(next, this.headers)) return;
      this.headers = next;
      this.dom.replaceChildren(...next.map((h) => this.row(h)));
    }

    private row(header: StickyHeader): HTMLElement {
      const row = document.createElement("div");
      row.className = STICKY_ROW_CLASS;
      row.textContent = header.text;
      row.title = `Go to line ${header.line}`;
      // Scrolls without moving the caret: this is a way of looking somewhere,
      // not of going there, and taking the selection with it would lose the
      // place the reader was actually working in.
      row.onclick = () => this.view.dispatch({ effects: EditorView.scrollIntoView(header.from, { y: "start" }) });
      return row;
    }
  },
);

const stickyTheme = EditorView.baseTheme({
  // Absolutely positioned inside `view.dom`, which CodeMirror's own base theme
  // pins `position: relative`. That element does not scroll (the scroller inside
  // it does), so `top: 0` is what makes the overlay stay put. It would sit over
  // a *top* panel that took height; the find widget is a top panel that takes
  // none and floats above this, and vim's status line is a bottom one.
  [`.${STICKY_CLASS}`]: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    borderBottom: "1px solid var(--border-default)",
    // The container is only a stack; the rows take their own clicks, so nothing
    // here swallows a click meant for the file.
    pointerEvents: "none",
  },
  // No scopes above the viewport is the ordinary state, and a bare border across
  // the top of an unscrolled file would be chrome that means nothing.
  [`.${STICKY_CLASS}:empty`]: { display: "none" },
  [`.${STICKY_ROW_CLASS}`]: {
    // Opaque, because this stands in front of the lines it is describing.
    background: "var(--canvas-card)",
    color: "var(--fg-default)",
    // The two vars `.cm-content` reads. A header set in the UI font would not
    // read as a line of the file it was lifted out of, and its indentation
    // would not line up with the code below it.
    fontFamily: 'var(--editor-font-family, "SF Mono", Menlo, Monaco, monospace)',
    fontSize: "var(--editor-font-size, 13px)",
    cursor: "pointer",
    pointerEvents: "auto",
    padding: "1px 6px",
    whiteSpace: "pre",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  [`.${STICKY_ROW_CLASS}:hover`]: { background: "var(--neutral-hover)" },
});

/** Pin the enclosing scopes of the top visible line over the top of the file. */
export function stickyScroll(): Extension {
  return [stickyPlugin, stickyTheme];
}
