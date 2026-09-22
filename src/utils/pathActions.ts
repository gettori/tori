// The two things every surface offers for a path it is already showing: put it
// on the clipboard, and show it in Finder. Shared, because the tree and the tab
// strip mean exactly the same thing by both, down to the toast they raise when
// it fails.
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { emitWith, TOAST, type ToastEvent } from "./events";

/** Copy the paths, one per line. */
export async function copyPaths(paths: string[]) {
  if (!(await copyText(paths.join("\n")))) {
    emitWith<ToastEvent>(TOAST, { message: "Could not copy to the clipboard." });
  }
}

/** Show the paths in Finder. Reads nothing and writes nothing, so it is offered
 *  on a read-only tree too. */
export async function revealPaths(paths: string[]) {
  try {
    // Singular name, plural argument: the plugin kept the old command name when
    // it grew multi-select, and renames it only in its next major.
    await invoke("plugin:opener|reveal_item_in_dir", { paths });
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}
