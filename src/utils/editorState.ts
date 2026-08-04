// What the editor pane is showing right now, published for consumers that
// cannot reach into it.
//
// The same shape of thing as `chatSessions.ts`, and for the same reason: the
// command palette has to know whether there is a file to save before it offers
// "Save file", and it is a sibling of the editor, not a child. Passing this down
// as props would mean threading it through App and every pane between them, and
// the palette is not the last consumer that will want it.
//
// A snapshot rather than live signals, so a reader cannot half-update: the
// active path and its dirty flag always describe the same moment.
import { createSignal } from "solid-js";
import type { JumpEntry } from "./jumpList";

export type EditorSnapshot = {
  /** Absolute path of the active tab, or null when nothing is open. */
  activePath: string | null;
  /** Does the active tab hold unsaved edits? */
  dirty: boolean;
  /** Tabs open in the visible workspace. */
  tabCount: number;
  /** The selected workspace (branch-unit folder), which is the editor's root. */
  projectRoot: string | null;
  /** Where the jump list has just been, newest first, for the omnibox's empty
   *  box. Published rather than read out of the editor for this module's whole
   *  reason: the omnibox is the editor's sibling, and the list is session-lived,
   *  so there is no storage for it to read the way it reads frecency. */
  recentJumps: readonly JumpEntry[];
};

const EMPTY: EditorSnapshot = {
  activePath: null,
  dirty: false,
  tabCount: 0,
  projectRoot: null,
  recentJumps: [],
};

const [editorState, setEditorState] = createSignal<EditorSnapshot>(EMPTY);
export { editorState };

/** Called by Editor.tsx from an effect over the state it already owns. */
export function publishEditorState(next: EditorSnapshot) {
  setEditorState(next);
}

/** Reset. Only the editor unmounting should reach this: a consumer reading a
 *  path from a pane that is gone would offer to save a buffer nobody holds. */
export function clearEditorState() {
  setEditorState(EMPTY);
}
