// Re-resolving every open buffer's LSP compartment when the language client's
// lifecycle moves (it comes up, goes away, or a project switch replaces it).
//
// Split out of CodeEditor because the interesting part is a pure state
// transformation over CM6 primitives: a background buffer holds an EditorState
// that is in no view at all, so it cannot be dispatched to, and the only handle
// on it is `state.update`. That distinction is exactly what needs a test, and
// testing it here costs nothing, where testing it through the component would
// mean standing up CodeMirror in jsdom.

import type { EditorState, Compartment, Extension, StateEffect } from "@codemirror/state";

export type LspBuffer = { state: EditorState; lsp: Compartment };

/**
 * Point one compartment of every buffer at what `resolve` now says.
 *
 * A buffer on screen has its live truth in a view's own state rather than the
 * stashed one, so its effect goes through that view: `dispatch` answers with
 * the view holding a path, or null for a buffer no pane is showing, which is
 * updated in place instead.
 *
 * `pick` names which compartment, because a buffer has more than one thing that
 * moves when the client does: the plugin itself, and the fallback completion
 * that exists only while no server is claiming the file.
 */
export function reconfigureBuffers<T extends { state: EditorState }>(
  buffers: Iterable<[string, T]>,
  pick: (buf: T) => Compartment,
  resolve: (path: string) => Extension,
  dispatch: (path: string, effects: StateEffect<unknown>) => boolean,
): void {
  for (const [path, buf] of buffers) {
    const effects = pick(buf).reconfigure(resolve(path));
    if (!dispatch(path, effects)) buf.state = buf.state.update({ effects }).state;
  }
}

/** Point every buffer's LSP compartment at what `resolve` now says. */
export function reattachLsp<T extends LspBuffer>(
  buffers: Iterable<[string, T]>,
  resolve: (path: string) => Extension,
  dispatch: (path: string, effects: StateEffect<unknown>) => boolean,
): void {
  reconfigureBuffers(buffers, (buf) => buf.lsp, resolve, dispatch);
}
