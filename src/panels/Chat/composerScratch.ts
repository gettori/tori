// Open in editor: the draft lives in a scratch file, the editor is the only
// writer while the link stands, every save mirrors back, the composer sends.
// The link ends on send, tab close or "edit here", and the file goes with it.
import { invoke } from "@tauri-apps/api/core";
import { newScratchFile } from "../../utils/scratch";
import { liveBufferText } from "../Editor/liveBuffers";
import { draftFor, linkedScratchFor, setDraft, setLinkedScratch, type ComposerKey } from "../../utils/chatCompose";
import {
  emitWith,
  onWith,
  EDITOR_CLOSE_PATH,
  EDITOR_FILE_SAVED,
  EDITOR_PROMPT_DONE,
  EDITOR_TAB_CLOSED,
  FOCUS_SESSION_TAB,
  OPEN_IN_EDITOR,
  type EditorClosePath,
  type EditorFileSaved,
  type EditorPromptDone,
  type EditorTabClosed,
  type FocusSessionTab,
  type OpenInEditor,
} from "../../utils/events";

/** Write the draft to a new scratch file, link it, and open it. Null when the
 *  backend could not make the file, and then nothing is linked. */
export async function openDraftInEditor(key: ComposerKey): Promise<string | null> {
  const path = await newScratchFile({ prompt: true });
  if (!path) return null;
  await invoke("fs_write_file", { path, contents: draftFor(key) });
  setLinkedScratch(key, path);
  emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path });
  return path;
}

/** End the link and remove the file. `closeTab` also takes the editor's text
 *  (saved or not) into the draft and closes the tab without a discard prompt;
 *  a close the editor itself reported needs neither. */
export async function unlinkScratch(key: ComposerKey, opts: { closeTab: boolean }): Promise<void> {
  const path = linkedScratchFor(key);
  if (!path) return;
  // Cleared first, so the close the editor reports back finds nothing to do.
  setLinkedScratch(key, null);
  if (opts.closeTab) {
    const live = liveBufferText(path);
    if (live !== null) setDraft(key, live);
    emitWith<EditorClosePath>(EDITOR_CLOSE_PATH, { path, discard: true });
  }
  await invoke("scratch_remove", { path }).catch(() => {});
}

/** A save the editor reported. Mirrored into the draft only for the linked
 *  file; every other save is someone else's. */
export function mirrorSaved(key: ComposerKey, saved: EditorFileSaved): boolean {
  if (saved.path !== linkedScratchFor(key)) return false;
  setDraft(key, saved.contents);
  return true;
}

/** A tab the editor reported closed. The link ends and the file goes; the
 *  draft keeps whatever the last save mirrored. */
export async function scratchTabClosed(key: ComposerKey, closed: EditorTabClosed): Promise<void> {
  if (closed.path !== linkedScratchFor(key)) return;
  await unlinkScratch(key, { closeTab: false });
}

/** What a send carries when the draft is linked: the editor's text, saved or
 *  not. The link ends and the tab and its file go with it. */
export function takeScratch(key: ComposerKey, text: string): string {
  const path = linkedScratchFor(key);
  const live = path ? liveBufferText(path) : null;
  void unlinkScratch(key, { closeTab: true });
  return live ?? text;
}

/** Answer the editor for this composer's linked file: each save, the close,
 *  and the editor's own done, which also brings the chat tab back. Returns the
 *  unsubscribe. */
export function followScratch(key: ComposerKey, tabId: string): () => void {
  const offSaved = onWith<EditorFileSaved>(EDITOR_FILE_SAVED, (saved) => mirrorSaved(key, saved));
  const offClosed = onWith<EditorTabClosed>(EDITOR_TAB_CLOSED, (closed) => void scratchTabClosed(key, closed));
  const offDone = onWith<EditorPromptDone>(EDITOR_PROMPT_DONE, ({ path }) => {
    if (path !== linkedScratchFor(key)) return;
    void unlinkScratch(key, { closeTab: true });
    emitWith<FocusSessionTab>(FOCUS_SESSION_TAB, { tabId });
  });
  return () => {
    offSaved();
    offClosed();
    offDone();
  };
}
