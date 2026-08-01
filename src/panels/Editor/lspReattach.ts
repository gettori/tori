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
 * Point every buffer's LSP compartment at what `resolve` now says.
 *
 * The shown buffer's live truth is the view's own state, not the stashed one,
 * so its effect goes through `dispatch`. Every other buffer is updated in
 * place. Callers pass `shown: null` when no buffer is on screen.
 */
export function reattachLsp<T extends LspBuffer>(
  buffers: Iterable<[string, T]>,
  shown: string | null,
  resolve: (path: string) => Extension,
  dispatch: (effects: StateEffect<unknown>) => void,
): void {
  for (const [path, buf] of buffers) {
    const effects = buf.lsp.reconfigure(resolve(path));
    if (path === shown) dispatch(effects);
    else buf.state = buf.state.update({ effects }).state;
  }
}
