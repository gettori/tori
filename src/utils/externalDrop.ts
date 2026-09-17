/**
 * Drops that started outside the app: a file or folder dragged in from Finder.
 *
 * Those arrive as ordinary `dragover`/`drop` events, because `dragDropEnabled`
 * is off in tauri.conf.json. It has to be: Tauri's own drag-drop handler always
 * reports the drag as handled, and wry then returns without passing it to
 * WebKit, which kills every in-app drag as well (a tab between panes, a tree
 * move, a chip into the sentence). The flag reads as a Windows-only concern in
 * the docs and is not one.
 *
 * What the DOM withholds is the path: WebKit hands over a `File` with a name and
 * bytes and nothing saying where it came from. `droppedPaths` is the way back to
 * one, so a drop can be a copy the backend performs rather than bytes shuttled
 * through the webview.
 */
import { invoke } from "@tauri-apps/api/core";

/** Is this drag carrying files from another app? Read from `types`, since a
 *  `dragover` may see the shape of a payload but never its data. */
export function isFileDrag(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes("Files");
}

/**
 * The absolute paths the drag being let go of right now is holding.
 *
 * Read from the macOS drag pasteboard, which the source app filled and which
 * outlives the drop, rather than from the event: WebKit withholds a dropped
 * file's path on purpose and no DOM API gives it back.
 *
 * Empty for a drag with nothing on disk behind it (a promised file from Mail, an
 * image dragged off a web page), where there is no copy to make and the caller
 * says so.
 */
export function droppedPaths(): Promise<string[]> {
  return invoke<string[]>("drag_paths").catch(() => []);
}
