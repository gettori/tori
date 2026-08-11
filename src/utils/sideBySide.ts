// The side-by-side diff preference, shared by every surface that renders a
// hunk.
//
// One key and one threshold, not one per panel: a reader who turned two columns
// on in the Changes panel has expressed a preference about reading diffs, not
// about that panel. Keeping them separate would mean the same hunk renders two
// ways in one app depending on where you found it, which is exactly the drift
// the shared renderer exists to prevent.
//
// **And now one signal, not one per panel either.** Four surfaces plus the
// Settings row read this; each used to seed its own signal at mount, so two diff
// views open at once disagreed the moment either was toggled - the shared key
// was shared only across sessions. Same shape as the zoom signal in
// `panels/Settings/settingsStore.ts`.
//
// The key keeps its original `review` name so an existing preference survives
// this becoming shared; renaming it would silently reset everyone.
import { createSignal } from "solid-js";

export const SIDE_BY_SIDE_KEY = "sway.review.sideBySide";

/** Below this the two columns are too narrow to read, so side-by-side falls
 *  back to inline regardless of the persisted preference. */
export const SIDE_BY_SIDE_MIN_WIDTH = 640;

export function readSideBySide(): boolean {
  return localStorage.getItem(SIDE_BY_SIDE_KEY) === "1";
}

const [sideBySideOn, setSideBySideSignal] = createSignal(readSideBySide());

/** The live preference, read by every diff surface and by the Settings row. */
export { sideBySideOn };

export function writeSideBySide(on: boolean): void {
  setSideBySideSignal(on);
  localStorage.setItem(SIDE_BY_SIDE_KEY, on ? "1" : "0");
}

/** Re-seed the signal from localStorage. For tests, which write the key directly
 *  to stand in for a previous session; the app reads the key once, at import. */
export function reloadSideBySide(): void {
  setSideBySideSignal(readSideBySide());
}
