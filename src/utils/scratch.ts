// Scratch buffers: the untitled tabs Cmd+N opens.
//
// The whole design is one sentence: **a scratch is a real file in
// `~/.config/tori/scratch/`, not a new kind of tab.** Everything downstream is
// path-keyed already - the tab strip, the dirty map, CodeEditor's buffers, the
// hot-exit stash, and `editorTabPersist`'s per-workspace restore - so a scratch
// with an ordinary absolute path needs a branch in none of them. The obvious
// alternative, a synthetic `tori://scratch/…` id like the graph's, would
// have cost a special case in each, and `toStore` drops synthetic ids on
// purpose, so an untitled tab could never have survived a relaunch at all.
//
// What is left is the small amount that a path cannot answer on its own, and it
// is all here: whether a given path *is* a scratch (which the backend's
// directory decides), and where the Save-as prompt's answer points.
//
// See `src-tauri/src/scratch.rs` for the naming and creation half.

import { invoke } from "@tauri-apps/api/core";

/**
 * Is this path one of the scratch files?
 *
 * Strictly *under* the directory, so a sibling that merely starts with the same
 * characters (`…/tori/scratchpad/notes.md`) is not swept up by the two rules
 * that read this: closing an untouched scratch deletes its file, and saving one
 * under a new name removes the old.
 *
 * A null directory (the backend has not answered yet, or could not) means "no
 * path is a scratch", which is the safe direction: both rules then decline to
 * delete anything.
 */
export function isScratchPath(path: string, dir: string | null): boolean {
  return !!dir && path.startsWith(`${dir}/`);
}

/** What the Save-as prompt starts with: the name the scratch already has, so
 *  answering with a bare extension (`.md`) is the shortest useful edit. */
export function defaultSaveName(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Where an answer to the Save-as prompt points.
 *
 * A leading `/` is taken literally, so a file can be saved anywhere; anything
 * else is read against the selected workspace, because that is the folder the
 * person typing a bare `notes.md` means. With no workspace selected there is no
 * such folder, and guessing at one (the home directory, the scratch directory)
 * would put the file somewhere nobody chose, so the save is refused instead.
 *
 * Null for an answer that names no file: a cancelled prompt, an empty one, or a
 * directory (`src/`), which is a place to save into and not a thing to save.
 */
export function resolveSavePath(answer: string | null, root: string | null): string | null {
  const typed = answer?.trim();
  if (!typed || typed.endsWith("/")) return null;
  if (typed.startsWith("/")) return typed;
  if (!root) return null;
  return `${root}/${typed}`;
}

// --- backend ---

/** Where scratch files live, or null when the backend cannot say (which leaves
 *  `isScratchPath` answering false for everything, so nothing is deleted). */
export async function scratchDirPath(): Promise<string | null> {
  try {
    return (await invoke<string>("scratch_dir")) || null;
  } catch {
    return null;
  }
}

/** Create the next empty scratch file, or null when it could not be created.
 *  `prompt` names it `prompt-N` rather than `Untitled-N`. */
export async function newScratchFile(opts: { prompt?: boolean } = {}): Promise<string | null> {
  try {
    return await invoke<string>("scratch_new", { prompt: !!opts.prompt });
  } catch {
    return null;
  }
}
