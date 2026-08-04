// Where an open results buffer lives while its tab is not the one on screen.
//
// The Editor renders a synthetic tab's view only while that tab is active
// (`Editor.tsx`'s `<Show when={syntheticTab()}>`), so switching to another tab
// unmounts this one and takes its CodeMirror state with it. A read-only view
// like the commit log does not care. A buffer somebody has typed edits into
// very much does, so the state lives out here instead, the same way
// `CodeEditor`'s `closedBuffers` map does and for the same reason.
//
// Keyed by the tab's synthetic id, which carries the workspace *and* the query,
// so two workspaces searching the same word are two buffers and re-running one
// query lands back in the tab that already has your edits in it.

// A type-only CodeMirror import: this module is reachable from the Search
// panel, which is on the eager path, and a value import would drag the library
// into the main chunk (see the lazy edge in `Editor.tsx`).
import type { EditorState } from "@codemirror/state";
import { syntheticId } from "../../utils/syntheticTabs";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import { buildSearchDoc, collectEdits, type ResultMatch, type SearchDoc } from "./searchResultsDoc";

export type SearchBuffer = {
  doc: SearchDoc;
  /** The live CodeMirror state, kept current by the mounted view so a tab
   *  switch (or a second Open click) never reads a stale document. */
  state: EditorState | null;
};

// Bounded, because nothing else collects these: a closed tab keeps its buffer
// so that reopening the same search hands back the edits rather than dropping
// them silently. Four is well past what anyone has open at once, and a result
// set is a few hundred short strings.
const MAX_BUFFERS = 4;
const buffers = new Map<string, SearchBuffer>();

/** The tab id one search materialises into. */
export function searchResultsId(root: string, query: string): string {
  return syntheticId("search", root, query);
}

export function searchBuffer(id: string): SearchBuffer | null {
  return buffers.get(id) ?? null;
}

/** Test seam: these outlive any one component, so a suite has to be able to
 *  start from nothing. */
export function clearSearchBuffers(): void {
  buffers.clear();
}

/** Does this buffer hold edits nobody has applied yet? */
function hasPendingEdits(buf: SearchBuffer): boolean {
  if (!buf.state) return false;
  return collectEdits(buf.doc, buf.state.doc.toJSON()).length > 0;
}

/**
 * Materialise a result set as a tab, and show it.
 *
 * A buffer with unapplied edits is **not** rebuilt: the click that would
 * refresh it is the same click that opened it, and quietly throwing away typed
 * edits to hand back a fresher copy of what they were made from is the one
 * outcome worth ruling out. It is focused as it stands instead.
 */
export function openSearchResults(root: string, query: string, matches: ResultMatch[]): string {
  const id = searchResultsId(root, query);
  const existing = buffers.get(id);
  if (!existing || !hasPendingEdits(existing)) {
    buffers.delete(id);
    buffers.set(id, { doc: buildSearchDoc(root, query, matches), state: null });
    for (const oldest of buffers.keys()) {
      if (buffers.size <= MAX_BUFFERS) break;
      buffers.delete(oldest);
    }
  }
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: id });
  return id;
}
