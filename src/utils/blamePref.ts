// Whether the editor shows git blame. A reader preference, kept the same way
// the side-by-side diff preference is (`sideBySide.ts`): one localStorage key,
// read at mount, written on toggle.
//
// Not a `settings.json` field, which would put it in the Rust settings shape and
// the Settings window. Blame is something you switch on while reading one file
// and off again a minute later, like the preview toggle beside it.

export const BLAME_KEY = "sway.editor.blame";

/** Off by default: blame is a question you ask, and asking it costs a gutter
 *  column and a line of text beside the cursor on every file you open. */
export function readBlamePref(): boolean {
  return localStorage.getItem(BLAME_KEY) === "1";
}

export function writeBlamePref(on: boolean): void {
  localStorage.setItem(BLAME_KEY, on ? "1" : "0");
}
