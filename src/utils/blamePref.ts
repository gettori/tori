// Whether the editor shows git blame. A reader preference, kept the same way
// the side-by-side diff preference is (`sideBySide.ts`): one localStorage key,
// read once, written on every change.
//
// Not a `settings.json` field, which would put it in the Rust settings shape and
// its workspace overlay. Blame is something you switch on while reading one file
// and off again a minute later, like the preview toggle beside it.
//
// **A module-level signal, not a per-component one.** It is reached from two
// places now - the editor's own toggle and the Settings row - and a signal per
// consumer meant each held whatever the key said when it mounted. Two surfaces
// then disagreed until a remount. Same shape as the zoom signal in
// `panels/Settings/settingsStore.ts`, and for the same reason.
import { createSignal } from "solid-js";

export const BLAME_KEY = "sway.editor.blame";

/** Off by default: blame is a question you ask, and asking it costs a gutter
 *  column and a line of text beside the cursor on every file you open. */
export function readBlamePref(): boolean {
  return localStorage.getItem(BLAME_KEY) === "1";
}

const [blameOn, setBlameOnSignal] = createSignal(readBlamePref());

/** The live preference. Every surface reads this rather than localStorage, so a
 *  change anywhere reaches all of them at once. */
export { blameOn };

export function writeBlamePref(on: boolean): void {
  setBlameOnSignal(on);
  localStorage.setItem(BLAME_KEY, on ? "1" : "0");
}

/** Re-seed the signal from localStorage. For tests, which write the key directly
 *  to stand in for a previous session; the app reads the key once, at import. */
export function reloadBlamePref(): void {
  setBlameOnSignal(readBlamePref());
}
