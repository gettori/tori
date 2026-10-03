// Open in editor: the draft lives in a scratch file, the editor is the only
// writer while the link stands, every save mirrors back, the composer sends.
// The link ends on send, tab close or "edit here", and the file goes with it.
import { invoke } from "@tauri-apps/api/core";
import { newScratchFile } from "../../utils/scratch";
import { liveBufferText } from "../Editor/liveBuffers";
import { draftFor, linkedScratchFor, setDraft, setLinkedScratch, type ComposerKey } from "../../utils/chatCompose";
import {
  emitWith,
  EDITOR_CLOSE_PATH,
  OPEN_IN_EDITOR,
  type EditorClosePath,
  type EditorFileSaved,
  type EditorTabClosed,
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
