// Where a Search Editor tab keeps its state while it is not the one on screen.
//
// The Editor renders a synthetic tab's view only while that tab is active
// (`Editor.tsx`'s `<Show when={syntheticTab()}>`), so switching to another tab
// unmounts this one and takes its CodeMirror state with it. A buffer somebody
// has typed edits into very much cares, so the state lives out here instead,
// the same way `CodeEditor`'s `closedBuffers` map does and for the same reason.
//
// One tab per open, like VS Code with `reusePriorSearchEditor` off: the id
// carries the workspace and a sequence number, and the query lives in the tab's
// own form, which can change under it.

// A type-only CodeMirror import: this module is reachable from the Search
// panel, which is on the eager path, and a value import would drag the library
// into the main chunk (see the lazy edge in `Editor.tsx`).
import type { EditorState } from "@codemirror/state";
import { createSignal } from "solid-js";
import { syntheticId } from "../../utils/syntheticTabs";
import {
  emitWith,
  onWith,
  EDITOR_TAB_CLOSED,
  OPEN_IN_EDITOR,
  type EditorTabClosed,
  type OpenInEditor,
} from "../../utils/events";
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions } from "../../utils/searchOptions";
import type { DocRoot, ResultMatch, SearchDoc } from "./searchResultsDoc";

/** What the tab's own inputs hold. */
export type EditorForm = {
  query: string;
  options: SearchOptions;
  /** Member repo paths the search is narrowed to; empty means every member. */
  repos: string[];
  /** Lines shown around each hit, and whether they are shown at all. */
  context: number;
  showContext: boolean;
  openOnly: boolean;
};

export const DEFAULT_CONTEXT_LINES = 1;

export function blankForm(): EditorForm {
  return {
    query: "",
    options: { ...DEFAULT_SEARCH_OPTIONS },
    repos: [],
    context: DEFAULT_CONTEXT_LINES,
    showContext: true,
    openOnly: false,
  };
}

export type SearchBuffer = {
  form: EditorForm;
  /** Null until the tab's first search lands. */
  doc: SearchDoc | null;
  /** Hits handed over by the Search panel, built into `doc` on first mount so
   *  the tab shows what the panel showed, dismissals included. */
  seed: { matches: ResultMatch[]; roots: DocRoot[] } | null;
  /** The live CodeMirror state, kept current by the mounted view so a tab
   *  switch never reads a stale document. */
  state: EditorState | null;
  closed: boolean;
};

// A closed tab keeps its buffer so reopening it hands back the edits; only
// closed ones are ever dropped, and only past this many.
const KEEP_CLOSED = 4;
const buffers = new Map<string, SearchBuffer>();
let seq = 0;

const [titles, setTitles] = createSignal<Record<string, string>>({});

export function searchBuffer(id: string): SearchBuffer | null {
  return buffers.get(id) ?? null;
}

/** The tab strip's label, which follows the query as the tab re-runs. */
export function searchTabTitle(id: string): string | null {
  return titles()[id] ?? null;
}

export function noteSearchQuery(id: string, query: string) {
  setTitles((t) => ({ ...t, [id]: query ? `Search: ${query}` : "Search" }));
}

/** The absolute roots a tab's rows write into, or null for an id that names no
 *  buffer. For `purgeTabsUnder`: inside a Topic the id's workspace is a key,
 *  not a folder, so only the document knows which repos it reaches into. */
export function searchBufferRoots(id: string): string[] | null {
  const buf = buffers.get(id);
  if (!buf) return null;
  const roots = buf.doc?.roots ?? buf.seed?.roots ?? [];
  return roots.map((r) => r.root);
}

/** Test seam: these outlive any one component. */
export function clearSearchBuffers(): void {
  buffers.clear();
  setTitles({});
}

/** Open a new Search Editor tab, blank or seeded with the panel's form and
 *  hits. Returns the tab id. */
export function openSearchEditor(
  workspace: string,
  form: EditorForm = blankForm(),
  seed: SearchBuffer["seed"] = null,
): string {
  const id = syntheticId("search", workspace, String(++seq));
  buffers.set(id, {
    form: { ...form, options: { ...form.options }, repos: [...form.repos] },
    doc: null,
    seed,
    state: null,
    closed: false,
  });
  noteSearchQuery(id, seed ? form.query : "");
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: id });
  return id;
}

onWith<EditorTabClosed>(EDITOR_TAB_CLOSED, ({ path }) => {
  const buf = buffers.get(path);
  if (!buf) return;
  buf.closed = true;
  const closed = [...buffers].filter(([, b]) => b.closed);
  for (const [id] of closed.slice(0, Math.max(0, closed.length - KEEP_CLOSED))) buffers.delete(id);
});

onWith<OpenInEditor>(OPEN_IN_EDITOR, ({ path }) => {
  const buf = buffers.get(path);
  if (buf) buf.closed = false;
});
