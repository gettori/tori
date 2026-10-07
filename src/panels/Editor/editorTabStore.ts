// The editor pane's tab model, module-level so the unified tab store (plan
// phase 4) can compose it without mounting the panel; terminalTabStore is the
// sibling. Editor.tsx resets it at setup: the lifetime still tracks the panel.
import { createSignal } from "solid-js";
import type { ClosedStore } from "./reopenStack";

// Every editor tab is a file now that the transcript viewer is gone, so a tab
// *is* its path: `tabId` and `FileTab.path` are the same string, and the tab
// bar's `idOf` is what still names the mapping.
export type FileTab = {
  path: string;
  name: string;
  /** The pane's one replaceable tab. A transient open takes this slot over
   *  rather than adding a tab, so reading twenty files leaves one behind
   *  instead of twenty. Absent once it is kept. */
  transient?: boolean;
};

// Tabs belong to a workspace (branch-unit folder), not to the editor: a file
// open in one worktree has no meaning in another, and usually does not exist
// there. Switching branch-unit therefore swaps the strip, and coming back
// restores the strip you left. Both maps are keyed by workspace and read
// through Editor.tsx's ws-scoped accessors, so every call site still says
// `tabs()`.
//
// The empty-string key is the bucket for "no selection yet". Nothing can
// select into it, so it is transient by construction, and `toStore` refuses to
// persist under it.
const [tabsByWs, setTabsByWs] = createSignal<Record<string, FileTab[]>>({});
const [activeByWs, setActiveByWs] = createSignal<Record<string, string | null>>({});
// The tabs you closed, for Cmd+Shift+T. Session-lived on purpose: reopening
// is an undo of something you just did, and last week's closes are what the
// history pickers are for.
const [closedByWs, setClosedByWs] = createSignal<ClosedStore>({});

export { tabsByWs, setTabsByWs, activeByWs, setActiveByWs, closedByWs, setClosedByWs };

// Called from Editor.tsx's setup, nowhere else: the panel mounts once per app
// run, so this keeps the model's lifetime what it was before the extraction
// (and gives repeated test mounts a fresh model without touching the tests).
export function resetEditorTabModel() {
  setTabsByWs({});
  setActiveByWs({});
  setClosedByWs({});
}

// The panel owns the restore (it needs the stash and the stored set it read at
// setup), so it registers how to start one. With no panel mounted there is
// nothing to restore and the answer is immediate.
let startFileRestore: ((ws: string) => Promise<void>) | null = null;

export function registerFileRestore(start: (ws: string) => Promise<void>): () => void {
  startFileRestore = start;
  return () => {
    if (startFileRestore === start) startFileRestore = null;
  };
}

// Starts this workspace's file restore or joins the one in flight, the
// editor's `stripReady`.
export function fileStripReady(ws: string): Promise<void> {
  return startFileRestore ? startFileRestore(ws) : Promise.resolve();
}
