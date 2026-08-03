// Cmd-click to go to a definition.
//
// The library binds go-to-definition to a key and nothing else; every editor a
// user has come from also does it on Cmd-click, and there is no equivalent to
// enable. The decision it makes is small but has four ways to be wrong (a
// plain click, a Cmd-click on empty space below the last line, a Cmd-click the
// LSP cannot answer, and a middle click), so it lives here as a plain function
// with the CM6 wrapper around it rather than inside the extension.

import { EditorView } from "@codemirror/view";
import type { Command } from "@codemirror/view";
import { jumpToDefinition } from "@codemirror/lsp-client";

/**
 * Handle a mousedown as a possible Cmd-click jump. Returns whether it was
 * handled, which is what tells CodeMirror to stop treating it as a click.
 *
 * The caret is moved to the clicked position first: the LSP command reads the
 * selection, not the mouse, so without this it would answer about wherever the
 * caret happened to be.
 */
export function cmdClickDefinition(
  event: MouseEvent,
  view: EditorView,
  jump: Command = jumpToDefinition,
): boolean {
  if (!event.metaKey || event.button !== 0) return false;
  // Cmd-Alt-click and Cmd-Shift-click are CodeMirror's own multiple-cursor and
  // range gestures, and taking them would cost more than this adds.
  if (event.altKey || event.shiftKey || event.ctrlKey) return false;
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

/** Cmd-click to definition, as an editor extension. */
export const cmdClickDefinitionExtension = EditorView.domEventHandlers({
  mousedown: (event, view) => cmdClickDefinition(event, view),
});
