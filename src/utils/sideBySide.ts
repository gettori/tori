// The side-by-side diff preference, shared by every surface that renders a
// hunk.
//
// One key and one threshold, not one per panel: a reader who turned two columns
// on in the Changes panel has expressed a preference about reading diffs, not
// about that panel. Keeping them separate would mean the same hunk renders two
// ways in one app depending on where you found it, which is exactly the drift
// the shared renderer exists to prevent.
//
// The key keeps its original `review` name so an existing preference survives
// this becoming shared; renaming it would silently reset everyone.

export const SIDE_BY_SIDE_KEY = "sway.review.sideBySide";

/** Below this the two columns are too narrow to read, so side-by-side falls
 *  back to inline regardless of the persisted preference. */
export const SIDE_BY_SIDE_MIN_WIDTH = 640;

export function readSideBySide(): boolean {
  return localStorage.getItem(SIDE_BY_SIDE_KEY) === "1";
}

export function writeSideBySide(on: boolean): void {
  localStorage.setItem(SIDE_BY_SIDE_KEY, on ? "1" : "0");
}
