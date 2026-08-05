// Peek: a definition or a reference list shown *inside* the file you are
// reading, instead of navigating away from it.
//
// The point of a peek is that it costs nothing to close. Going to a definition
// loses your place, your scroll position and, if you were mid-edit, your train
// of thought; a peek is a way of *looking* somewhere, which is why nothing here
// touches the tab bar and why Esc puts everything back.
//
// **The peeked file is deliberately not registered with `SwayWorkspace`.** That
// class tracks the files the language server has been told about, and its
// bookkeeping (`files`, `openFile`, the headless sweep) exists to keep the
// server's idea of the world matching the editor's. A peek shows text; it does
// not open anything, the server was never told, and adding an entry for it
// would make the workspace claim a file that has no buffer and no view - the
// exact confusion [[gotchas#lsp-client-assumes-one-editor-view-per-file]] is
// about. The read-only view inside the widget is a private `EditorView` that
// the workspace has never heard of.

import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import type { PeekKind, PeekLocation } from "./peekLocations";

/** Lines of the file shown above the peeked line, for context. */
export const PEEK_CONTEXT_BEFORE = 2;

/** Most lines a peek renders. A peek is a glance, not a second editor: past
 *  this the widget is eating the file it was opened from, and the "open as a
 *  tab" button is the honest answer to wanting more. */
export const PEEK_MAX_LINES = 14;

/** The slice of a file a peek shows, and where it starts. */
export type PeekWindow = {
  text: string;
  /** 1-based line number of `text`'s first line, so the peek's gutter agrees
   *  with the real file's. */
  firstLine: number;
};

/**
 * The window of `source` to render for a location.
 *
 * Pure, and separate from the widget, because "which lines" is arithmetic with
 * three edges to get wrong (the top of the file, the bottom, and a target range
 * longer than the window) and none of them need a DOM to check.
 */
export function peekWindow(source: string, location: PeekLocation): PeekWindow {
  const lines = source.split("\n");
  const start = Math.max(0, location.line - PEEK_CONTEXT_BEFORE);
  // A fixed window from `start`, so a long definition shows its *head* rather
  // than being centred and showing neither end. `endLine` deliberately does not
  // widen it: the cap is what keeps a peek a glance, and "open as a tab" is the
  // answer to wanting the rest.
  const end = Math.min(lines.length, start + PEEK_MAX_LINES);
  return { text: lines.slice(start, end).join("\n"), firstLine: start + 1 };
}

/** Everything on screen for one peek. Resolved before it is dispatched, so the
 *  widget itself is synchronous and never awaits inside a DOM callback. */
export type PeekState = {
  kind: PeekKind;
  locations: PeekLocation[];
  /** Which location the source pane is showing. */
  index: number;
  /** The window for `locations[index]`, or null when its text was unreadable. */
  window: PeekWindow | null;
  /** Document position the widget is anchored after: the end of the line the
   *  peek was opened from. */
  anchorLine: number;
};

export const showPeek = StateEffect.define<PeekState>();
export const hidePeek = StateEffect.define<null>();

class PeekWidget extends WidgetType {
  private view: EditorView | null = null;

  constructor(
    readonly state: PeekState,
    /** Choosing a different result reloads its text, so it cannot be answered
     *  from inside a DOM callback; the controller owns it. Close needs nothing
     *  but a dispatch, so the widget does that itself. */
    readonly onSelect: (view: EditorView, index: number) => void,
  ) {
    super();
  }

  /**
   * Rebuilt only when what it draws changed.
   *
   * Identity on `locations` rather than a deep compare: a fresh request always
   * produces a fresh array, and two peeks holding the same array are the same
   * answer. Without this the nested `EditorView` would be torn down and rebuilt
   * on every unrelated transaction in the outer document, which loses its
   * scroll position while the user is reading it.
   */
  eq(other: PeekWidget): boolean {
    return (
      other.state.locations === this.state.locations &&
      other.state.index === this.state.index &&
      other.state.window?.text === this.state.window?.text
    );
  }

  toDOM(outer: EditorView): HTMLElement {
    const close = () => outer.dispatch({ effects: hidePeek.of(null) });
    const wrap = document.createElement("div");
    wrap.className = "cm-peek";
    // A block widget lives *inside* `contentDOM`, so the outer editor's own
    // handlers (vim's among them) are on ancestors of this element. Stopping
    // propagation here is what keeps Esc from reaching them: a descendant's
    // handler runs before an ancestor's bubble-phase one, so the peek gets
    // first refusal on the key and vim never sees it.
    //
    // The capture flag is belt and braces rather than the mechanism - bubble
    // here would beat contentDOM's bubble too. What is load-bearing is
    // `stopPropagation`, and the test named for this fails without it.
    wrap.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      },
      true,
    );
    wrap.appendChild(this.header(close));

    const body = document.createElement("div");
    body.className = "cm-peek-body";
    // Only when there is a choice to make. One result needs no list, and drawing
    // an empty one would make a definition look like a search that found itself.
    if (this.state.locations.length > 1) body.appendChild(this.list(outer));
    body.appendChild(this.source());
    wrap.appendChild(body);
    return wrap;
  }

  private header(closePeek: () => void): HTMLElement {
    const header = document.createElement("div");
    header.className = "cm-peek-header";

    const title = document.createElement("span");
    title.className = "cm-peek-title";
    const current = this.state.locations[this.state.index];
    title.textContent = this.state.locations.length
      ? this.state.kind === "references"
        ? `${this.state.locations.length} reference${this.state.locations.length === 1 ? "" : "s"}`
        : "Definition"
      : this.state.kind === "references"
        ? "No references"
        : "No definition";
    header.appendChild(title);

    if (current) {
      const where = document.createElement("span");
      where.className = "cm-peek-where";
      where.textContent = `${baseName(current.path)}:${current.line + 1}`;
      header.appendChild(where);

      const open = document.createElement("button");
      open.className = "cm-peek-open";
      open.type = "button";
      open.textContent = "Open as a tab";
      // The escape hatch. A peek is bounded on purpose, so the way out of it is
      // an ordinary open rather than a bigger widget.
      open.onclick = () => {
        emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: current.path, line: current.line + 1 });
        closePeek();
      };
      header.appendChild(open);
    }

    const close = document.createElement("button");
    close.className = "cm-peek-close";
    close.type = "button";
    close.title = "Close (Esc)";
    close.textContent = "×";
    close.onclick = () => closePeek();
    header.appendChild(close);
    return header;
  }

  private list(outer: EditorView): HTMLElement {
    const list = document.createElement("div");
    list.className = "cm-peek-list";
    this.state.locations.forEach((location, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cm-peek-row" + (i === this.state.index ? " cm-peek-row-active" : "");
      row.textContent = `${baseName(location.path)}:${location.line + 1}`;
      row.title = location.path;
      row.onclick = () => this.onSelect(outer, i);
      list.appendChild(row);
    });
    return list;
  }

  private source(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-peek-source";
    const window = this.state.window;
    if (!window) {
      const empty = document.createElement("div");
      empty.className = "cm-peek-empty";
      // Distinguishable from "no results": the server answered, and the file it
      // named could not be read.
      empty.textContent = this.state.locations.length ? "Could not read that file." : "Nothing to show.";
      host.appendChild(empty);
      return host;
    }
    // A private view the workspace has never heard of. No language, no
    // completion, no diagnostics: it renders text and numbers the lines.
    this.view = new EditorView({
      state: EditorState.create({
        doc: window.text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          // Offset so the gutter agrees with the file this came from. A peek
          // whose line numbers start at 1 is a peek you cannot cite.
          lineNumbers({ formatNumber: (n) => String(n + window.firstLine - 1) }),
        ],
      }),
      parent: host,
    });
    return host;
  }

  /** Called by CodeMirror when the decoration goes away, including when a
   *  reconfigure drops the field holding it. Without this the nested view keeps
   *  its listeners and its DOM alive with nothing pointing at it. */
  destroy(): void {
    this.view?.destroy();
    this.view = null;
  }

  /** Everything inside belongs to the widget, so the outer editor must not
   *  treat a click in the peek as a click in the document. */
  ignoreEvent(): boolean {
    return true;
  }
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * The open peek, or null.
 *
 * A `StateField` rather than a signal outside the editor, so a reconfigure or a
 * buffer swap takes the peek with it: the decoration is derived from the field,
 * and a field that is gone draws nothing. That is what stops a peek surviving
 * into a different file as an overlay nobody can close.
 */
export function peekField(onSelect: (view: EditorView, index: number) => void): StateField<PeekState | null> {
  return StateField.define<PeekState | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(showPeek)) return effect.value;
        if (effect.is(hidePeek)) return null;
      }
      // Follows the document, so an edit above the peek does not leave it
      // anchored to a line that has moved out from under it.
      if (value && tr.docChanged) {
        return { ...value, anchorLine: tr.changes.mapPos(value.anchorLine) };
      }
      return value;
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => {
        if (!value) return Decoration.none;
        return Decoration.set([
          Decoration.widget({
            widget: new PeekWidget(value, onSelect),
            // After the line, and its own block rather than inline: a peek is a
            // panel, not a piece of the sentence it was opened from.
            block: true,
            side: 1,
          }).range(value.anchorLine),
        ]);
      }),
  });
}

/** Esc closes the peek when the *outer* editor has focus. The widget has its
 *  own capture-phase handler for when focus is inside it, which is the case a
 *  keymap here cannot reach. */
export function peekKeymap(field: StateField<PeekState | null>): Extension {
  return keymap.of([
    {
      key: "Escape",
      run: (view) => {
        if (!view.state.field(field, false)) return false;
        view.dispatch({ effects: hidePeek.of(null) });
        return true;
      },
    },
  ]);
}

export const peekTheme = EditorView.baseTheme({
  ".cm-peek": {
    margin: "4px 0",
    border: "1px solid var(--border-default)",
    borderRadius: "4px",
    background: "var(--canvas-card)",
    overflow: "hidden",
  },
  ".cm-peek-header": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "3px 6px",
    borderBottom: "1px solid var(--border-default)",
    fontSize: "0.85em",
  },
  ".cm-peek-title": { fontWeight: "600" },
  ".cm-peek-where": { opacity: "0.7" },
  ".cm-peek-open": { marginLeft: "auto" },
  ".cm-peek-body": { display: "flex", maxHeight: "16em" },
  ".cm-peek-list": { minWidth: "12em", maxWidth: "20em", overflowY: "auto", borderRight: "1px solid var(--border-default)" },
  ".cm-peek-row": { display: "block", width: "100%", textAlign: "left", padding: "2px 6px", background: "none", border: "none" },
  ".cm-peek-row-active": { background: "var(--neutral-hover)" },
  ".cm-peek-source": { flex: "1", overflow: "auto" },
  ".cm-peek-empty": { padding: "6px", opacity: "0.7" },
});
