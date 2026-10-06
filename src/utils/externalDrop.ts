/**
 * Drops that started outside the app: a file or folder dragged in from Finder or
 * File Explorer.
 *
 * Those arrive as ordinary `dragover`/`drop` events, because `dragDropEnabled`
 * is off in tauri.conf.json. It has to be: Tauri's own drag-drop handler always
 * reports the drag as handled, and wry then returns without passing it to
 * the webview, which kills every in-app drag as well (a tab between panes, a
 * tree move, a chip into the sentence), on macOS and Windows alike.
 *
 * What the DOM withholds is the path: the webview hands over a `File` with a name and
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

type WebView2 = { postMessageWithAdditionalObjects(message: unknown, objects: FileList): void };

/**
 * The absolute paths the drop `e` is holding. Call it before any `await` in the
 * drop handler: the event's files are gone once the handler returns.
 *
 * WebKit and WebView2 both withhold a dropped file's path on purpose and no DOM
 * API gives it back. On macOS it is read from the drag pasteboard, which the
 * source app filled and which outlives the drop. On Windows the files go to the
 * host through WebView2's message channel, the one route that hands it their
 * paths, tagged with a nonce `drag_paths` then waits for.
 *
 * Empty for a drag with nothing on disk behind it (a promised file from Mail, an
 * image dragged off a web page), where there is no copy to make and the caller
 * says so.
 */
export function droppedPaths(e: DragEvent): Promise<string[]> {
  const webview = (window as { chrome?: { webview?: WebView2 } }).chrome?.webview;
  if (!webview) return invoke<string[]>("drag_paths").catch(() => []);
  const files = e.dataTransfer?.files;
  if (!files?.length) return Promise.resolve([]);
  const nonce = crypto.randomUUID();
  webview.postMessageWithAdditionalObjects({ toriDrop: nonce }, files);
  return invoke<string[]>("drag_paths", { nonce }).catch(() => []);
}
