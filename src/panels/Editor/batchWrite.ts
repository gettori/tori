// Writing a batch of files the editor changed on its own, without reading the
// result back as somebody else's edits.
//
// Its own module because two things need it now: a cross-file rename, and any
// `WorkspaceEdit` a server hands us. Both write files nobody is looking at, and
// both would otherwise raise a reload banner on every one of them.

import { invoke } from "@tauri-apps/api/core";
import { markSelfWrite } from "../../utils/selfWrites";

/**
 * Write every file as one call, with one echo-suppression window over the whole
 * operation.
 *
 * `isSelfWrite`'s TTL is sized for a single save. Marking each path as its own
 * write went out is what the editor does today, and at 150 files the first
 * mark would have expired long before the watcher's debounced echo for the last
 * one arrives, so the tail of the batch would read as somebody else's edits and
 * raise reload banners across the tree.
 *
 * Marked twice on purpose. The first pass covers an echo that arrives *while*
 * the batch is still writing; the second restarts the window from the moment
 * the batch finished, so the watcher's own debounce (a few hundred ms later)
 * still lands inside it however long the write took.
 *
 * The second pass runs only on success. A refused batch wrote nothing, so no
 * echo is coming, and holding the window open would swallow a genuine external
 * edit to one of those paths for the next second.
 */
export async function writeFilesSuppressingEcho(files: { path: string; contents: string }[]): Promise<string[]> {
  for (const f of files) markSelfWrite(f.path);
  const written = await invoke<string[]>("fs_write_files", { files });
  for (const f of files) markSelfWrite(f.path);
  return written;
}
