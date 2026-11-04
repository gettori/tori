// What every surface offers for a path it is already showing: put it on the
// clipboard, show it in Finder, or open it in its own app. Shared, because the
// tree and the tab strip mean exactly the same thing by each, down to the toast
// they raise when it fails.
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "./events";
import { isImagePath, isPdfPath } from "./pathScope";

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

/** Hand a document or media file to the app the system picks for it. The
 *  backend refuses anything that would run rather than show, and says so. */
export async function openInDefaultApp(path: string) {
  try {
    await invoke("open_in_default_app", { path });
  } catch (e) {
    emitWith<ToastEvent>(TOAST, { message: String(e) });
  }
}

/** Documents and media the backend lets a click hand to their default app
 *  (`OPENABLE_EXTENSIONS` in launch.rs) that Tori has no view for. The rest of
 *  that list (PDF, images, SVG, HTML, CSV) Tori shows itself. */
const DEFAULT_APP_ONLY = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "pages",
  "numbers",
  "key",
  "epub",
  "tif",
  "tiff",
  "heic",
  "heif",
  "psd",
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "avi",
]);

/** Open a file a link named: in Tori when it has a view for it, otherwise in the
 *  app the system picks, and in Finder when the backend will not launch it (an
 *  executable, or a kind with no app worth trusting). */
export async function openFile(path: string, line?: number) {
  if (!opensInDefaultApp(path) && (isImagePath(path) || isPdfPath(path) || (await isText(path)))) {
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path, line });
    return;
  }
  try {
    await invoke("open_in_default_app", { path });
  } catch {
    await revealPaths([path]);
  }
}

/** A probe that fails says nothing about the file, so the editor gets to try
 *  and say what it found. */
async function isText(path: string): Promise<boolean> {
  return invoke<boolean>("fs_is_text", { path }).then(
    (text) => text !== false,
    () => true,
  );
}

/** Whether `openFile` hands this path to its default app rather than to Tori. */
export function opensInDefaultApp(path: string): boolean {
  const ext = path.split("/").pop()?.split(".").slice(1).pop()?.toLowerCase() ?? "";
  return DEFAULT_APP_ONLY.has(ext);
}
