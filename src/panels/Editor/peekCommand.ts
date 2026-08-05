// Opening a peek: ask, read, show.
//
// Three steps and two of them are asynchronous, which is the whole reason this
// is a module rather than a callback in the extension list: `peekAt` guards the
// request, and reading the peeked file is a second await after it, so both have
// to answer to the same claim. `claimPeek` is that claim, and it lives in
// `peekLocations` rather than here so opening and selecting cannot end up
// holding two counters that disagree.

import type { EditorView } from "@codemirror/view";
import type { StateField } from "@codemirror/state";
import { claimPeek, peekAt, peekSourceText, type PeekKind, type PeekLocation } from "./peekLocations";
import { hidePeek, peekWindow, showPeek, type PeekState } from "./peekView";

async function windowFor(location: PeekLocation | undefined): Promise<PeekState["window"]> {
  if (!location) return null;
  const source = await peekSourceText(location.path);
  return source == null ? null : peekWindow(source, location);
}

/**
 * Peek from the caret in `view`, which is showing `path`.
 *
 * Resolves to whether a peek was shown. False covers every uninteresting case
 * identically - no server, no provider, the request failed, or a newer peek
 * overtook this one - because the caller's answer to all of them is the same:
 * leave the buffer alone and let the key fall through as unbound.
 */
export async function openPeek(view: EditorView, kind: PeekKind, path: string): Promise<boolean> {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);

  let shown = false;
  await peekAt(
    kind,
    path,
    // LSP counts lines from 0 and CodeMirror from 1. Converted once, here,
    // rather than at each end of the request.
    { line: line.number - 1, character: head - line.from },
    async (locations, stillCurrent) => {
      if (!locations) {
        // Nothing to show here. Closing rather than returning quietly: a peek
        // already open belongs to a *different* symbol, and leaving it up makes
        // the previous answer read as this question's - the same "right source,
        // wrong symbol" failure the request guard exists to prevent, arriving
        // through a door the guard does not cover. Unconditional because an
        // effect no open peek reads is a no-op.
        view.dispatch({ effects: hidePeek.of(null) });
        return;
      }
      const window = await windowFor(locations[0]);
      // Overtaken while the file was being read. Dispatching now would replace
      // a peek the user opened *after* this one with an older answer.
      if (!stillCurrent()) return;
      view.dispatch({
        effects: showPeek.of({
          kind,
          locations,
          index: 0,
          window,
          // Anchored to the end of the caret's line, so the widget opens
          // *below* the line being asked about rather than over it.
          anchorLine: line.to,
        }),
      });
      shown = true;
    },
  );
  return shown;
}

/** Show a different result from an open peek, reloading its source. */
export async function selectPeekResult(
  view: EditorView,
  field: StateField<PeekState | null>,
  index: number,
): Promise<void> {
  const current = view.state.field(field, false);
  if (!current || index < 0 || index >= current.locations.length) return;
  const stillCurrent = claimPeek();
  const window = await windowFor(current.locations[index]);
  if (!stillCurrent()) return;
  // Re-read rather than reusing `current`: the peek may have been closed, or
  // replaced by a different question, while its text was being read.
  const live = view.state.field(field, false);
  if (!live || live.locations !== current.locations) return;
  view.dispatch({ effects: showPeek.of({ ...live, index, window }) });
}
