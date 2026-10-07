// Cmd-click to go to a definition.
//
// The library binds go-to-definition to a key and nothing else; every editor a
// user has come from also does it on Cmd-click, and there is no equivalent to
// enable. The decision it makes is small but has four ways to be wrong (a
// plain click, a Cmd-click on empty space below the last line, a Cmd-click the
// LSP cannot answer, and a middle click), so it lives here as a plain function
// with the CM6 wrapper around it rather than inside the extension.

import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { Command, DecorationSet, ViewUpdate } from "@codemirror/view";
import { jumpToDefinition, LSPPlugin } from "@codemirror/lsp-client";
import { modOnly } from "../../utils/platform";

/**
 * Handle a mousedown as a possible Cmd-click jump. Returns whether it was
 * handled, which is what tells CodeMirror to stop treating it as a click.
 *
 * The caret is moved to the clicked position first: the LSP command reads the
 * selection, not the mouse, so without this it would answer about wherever the
 * caret happened to be.
 */
export function cmdClickDefinition(event: MouseEvent, view: EditorView, jump: Command = jumpToDefinition): boolean {
  // Mod alone: Mod-Alt-click and Mod-Shift-click are CodeMirror's own
  // multiple-cursor and range gestures, and taking them would cost more than this adds.
  if (!modOnly(event) || event.button !== 0) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  // Null below the last line or outside the content, where there is no symbol
  // to ask about.
  if (pos == null) return false;
  view.dispatch({ selection: { anchor: pos } });
  // False when this file has no server, or the server has no answer. Letting
  // the event through then leaves it an ordinary click rather than a dead one.
  if (!jump(view)) return false;
  event.preventDefault();
  return true;
}

type Span = { from: number; to: number };

const setLink = StateEffect.define<Span | null>();
const linkMark = Decoration.mark({ class: "cm-definition-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setLink)) return e.value ? Decoration.set(linkMark.range(e.value.from, e.value.to)) : Decoration.none;
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Underlines only what the server can answer, not every word: a keyword or a
// comment lit up as a link and then doing nothing on click is worse than no
// hint at all. Cmd pressed with the mouse still has no mouse event, so the
// modifier is read from window key events and the pointer from the last move.
class DefinitionLink {
  private pointer: { x: number; y: number } | null = null;
  private asked: Span | null = null;
  private seq = 0;

  constructor(readonly view: EditorView) {
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    // Cmd-Tab away never delivers the Meta keyup here.
    window.addEventListener("blur", this.clear);
  }

  update(u: ViewUpdate) {
    if (u.docChanged) this.forget();
  }

  destroy() {
    this.forget();
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("blur", this.clear);
  }

  onMove(event: MouseEvent) {
    this.pointer = { x: event.clientX, y: event.clientY };
    this.probe(modOnly(event));
  }

  onLeave() {
    this.pointer = null;
    this.clear();
  }

  private onKey = (event: KeyboardEvent) => this.probe(modOnly(event));

  private probe(held: boolean) {
    const span = held && this.pointer ? this.spanUnder(this.pointer) : null;
    if (!span) return this.clear();
    if (this.asked?.from === span.from && this.asked.to === span.to) return;
    this.clear();
    this.asked = span;

    const plugin = LSPPlugin.get(this.view);
    if (!plugin?.client.serverCapabilities?.definitionProvider) return;
    const mine = this.seq;
    plugin.client.sync();
    plugin.client
      .request<unknown, unknown>("textDocument/definition", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(span.from),
      })
      .then(
        (res) => {
          if (mine !== this.seq) return;
          if (Array.isArray(res) ? res.length === 0 : !res) return;
          this.view.dispatch({ effects: setLink.of(span) });
        },
        () => {},
      );
  }

  private spanUnder(pointer: { x: number; y: number }): Span | null {
    const pos = this.view.posAtCoords(pointer);
    const word = pos == null ? null : this.view.state.wordAt(pos);
    if (!word) return null;
    // posAtCoords snaps to the nearest character, so the pointer past the end
    // of a line would otherwise still light up the line's last word.
    const start = this.view.coordsAtPos(word.from, 1);
    const end = this.view.coordsAtPos(word.to, -1);
    if (!start || !end || pointer.x < start.left || pointer.x > end.right) return null;
    return stringInside(this.view.state, word.from) ?? { from: word.from, to: word.to };
  }

  private forget() {
    this.seq++;
    this.asked = null;
  }

  private clear = () => {
    this.forget();
    if (this.view.state.field(linkField).size) this.view.dispatch({ effects: setLink.of(null) });
  };
}

// An import path is one target to the server but several words to `wordAt`,
// which stops at every `/` and `.`. The span is the string's text without its
// quotes. The client does not advertise LocationLink support (the library's
// own jump cannot read one), so the server never says the span itself.
function stringInside(state: EditorState, pos: number): Span | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node && !/string/i.test(node.name)) node = node.parent;
  if (!node) return null;
  const text = state.sliceDoc(node.from, node.to);
  if (text.includes("\n")) return null;
  const quoted = text.length >= 2 && /^["'`]/.test(text) && text[text.length - 1] === text[0];
  return quoted ? { from: node.from + 1, to: node.to - 1 } : { from: node.from, to: node.to };
}

const definitionLink = ViewPlugin.fromClass(DefinitionLink, {
  eventHandlers: {
    mousemove(event) {
      this.onMove(event);
    },
    mouseleave() {
      this.onLeave();
    },
  },
});

const definitionLinkTheme = EditorView.baseTheme({
  ".cm-definition-link": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
});

/** Cmd-click to definition, and the underline that says a Cmd-click will go
 *  somewhere, as an editor extension. */
export const cmdClickDefinitionExtension = [
  linkField,
  definitionLink,
  definitionLinkTheme,
  EditorView.domEventHandlers({
    mousedown: (event, view) => cmdClickDefinition(event, view),
  }),
];
