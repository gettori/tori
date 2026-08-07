// Drawing a server's lenses above the lines they belong to.
//
// The CM6 half of code lens; the protocol half is `lspCodeLens.ts`. The two
// decisions worth knowing before reading this:
//
//   * **A lens is a block widget, so it changes the document's vertical
//     layout.** That is why the decorations come from a field provided
//     *directly* to `EditorView.decorations`: a set produced by a function is
//     computed after the viewport has already been measured, and CodeMirror
//     forbids introducing block widgets from there.
//
//   * **Lenses map through edits rather than being dropped on one.** A refresh
//     is a round trip to a subprocess, and discarding the widgets on every
//     keystroke would make every line in the file jump up and down the whole
//     time anyone is typing. So they are mapped and simply go stale until the
//     next answer lands, exactly as the semantic decorations beside them do.
//     What a mapped lens cannot do is stay *correct*, which is why the refresh
//     that follows an edit is what actually puts it back where it belongs.

import { StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { CodeLensItem } from "./lspCodeLens";

/** Replace this buffer's lenses wholesale. There is no incremental form: a
 *  `textDocument/codeLens` reply describes the whole document. */
export const setCodeLenses = StateEffect.define<CodeLensItem[]>();

/**
 * The strip above one line.
 *
 * Several lenses on one line become one widget rather than several, because
 * several block widgets at one position are several *rows*: "3 references" and
 * "1 implementation" would push the function two lines down the file instead of
 * sitting side by side the way every other editor draws them.
 */
class CodeLensWidget extends WidgetType {
  constructor(readonly titles: string[]) {
    super();
  }

  /** Compared by content, so a refresh that answers the same thing does not
   *  rebuild the DOM (and, since these are block widgets, does not re-measure
   *  the document's height) on every keystroke's worth of debounce. */
  eq(other: CodeLensWidget): boolean {
    return other.titles.length === this.titles.length && other.titles.every((t, i) => t === this.titles[i]);
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-codeLens";
    // Hidden from assistive technology, because none of this is document text.
    // The strip lives inside `contentDOM`, so a screen reader walking the file
    // would read "3 references" as a line of the source between the lines that
    // really are in it. The count is reachable without it (the references peek,
    // the Calls panel); a file whose text is not its text is not.
    wrap.setAttribute("aria-hidden", "true");
    for (const title of this.titles) {
      const span = document.createElement("span");
      span.className = "cm-codeLens-item";
      span.textContent = title;
      wrap.appendChild(span);
    }
    return wrap;
  }

  /** Nothing in here is a document position, so an event that starts in it is
   *  not the editor's to interpret. */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Decorations for `lenses` against `doc`.
 *
 * Every line is bounds-checked against the document being drawn into. The
 * caller only paints an answer whose document has not moved, but a truncated or
 * malformed reply is still a reply, and a line past the end would otherwise
 * throw inside a state field update, which takes the whole editor down rather
 * than losing one label.
 */
export function codeLensDecorations(doc: Text, lenses: CodeLensItem[]): DecorationSet {
  // Grouped by line, in the order the server sent them: a server that has an
  // opinion about which count matters most has already expressed it.
  const byLine = new Map<number, string[]>();
  for (const lens of lenses) {
    if (lens.title === null) continue;
    if (lens.line < 1 || lens.line > doc.lines) continue;
    const titles = byLine.get(lens.line);
    if (titles) titles.push(lens.title);
    else byLine.set(lens.line, [lens.title]);
  }

  const ranges: Range<Decoration>[] = [];
  for (const [line, titles] of byLine) {
    ranges.push(
      Decoration.widget({
        widget: new CodeLensWidget(titles),
        // Above the line, which is the whole convention: anchored at the line's
        // *start* with a negative side, where the peek widget is anchored at a
        // line's end with a positive one to sit below it.
        block: true,
        side: -1,
      }).range(doc.line(line).from),
    );
  }
  // Sorted rather than trusted, and that is load-bearing rather than
  // defensive: the bundled `typescript-language-server` concatenates its
  // implementation lenses with its reference ones (`cli.mjs:23048`) and hands
  // back lines 13, 41, 26 for a file with three exported symbols. An unsorted
  // set is a thrown error inside a state field, not a mislaid label.
  return Decoration.set(ranges, true);
}

const codeLensField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCodeLenses)) return codeLensDecorations(tr.state.doc, effect.value);
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** How many lens strips this state is holding. What a caller can ask without
 *  the field itself becoming part of the module's surface. */
export function codeLensCount(state: EditorState): number {
  return state.field(codeLensField, false)?.size ?? 0;
}

const codeLensTheme = EditorView.theme({
  ".cm-codeLens": {
    display: "flex",
    gap: "1.2em",
    // Lines up with the code rather than with the gutter: a lens describes the
    // symbol below it, so it reads as a label on that line and not as a row of
    // its own.
    paddingLeft: "2px",
    color: "var(--fg-subtle)",
    fontSize: "0.85em",
    // No vertical margin, deliberately. CodeMirror measures a block widget's
    // height and margins collapse, so a margin here is a document height the
    // editor and the browser disagree about.
    lineHeight: "1.4",
  },
  ".cm-codeLens-item": { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
});

/**
 * The per-buffer extension, or nothing.
 *
 * Resolved through a compartment rather than gated inside the field, so
 * switching the setting off takes the field, its decorations and the theme away
 * in one reconfigure and leaves nothing behind to clear.
 */
export function codeLensExtension(on: boolean): Extension {
  return on ? [codeLensField, codeLensTheme] : [];
}
