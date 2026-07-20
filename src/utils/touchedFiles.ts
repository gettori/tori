// Which files the *selected* session has written, shared as a signal so the
// file tree and the editor tabs can both mark them without prop-drilling
// through TreeNode's recursion (same pattern as sessionStatus's liveStatuses).
//
// Reads are deliberately excluded. `session_touched_files` reports reads too,
// but an agent reads far more than it writes, so tinting every read would
// light up most of the tree and stop meaning anything. The marker answers
// "did this session change this file", which is the question the tree can
// usefully answer at a glance.
//
// Scoped to one session at a time: all-sessions attribution (who touched what,
// historically) stays in the blame-by-session backlog item.
import { createSignal } from "solid-js";

export type TouchOp = "read" | "create" | "edit" | "delete";

/** Pure: the absolute paths a session actually wrote, dropping read-only touches. */
export function writtenPaths(files: readonly { path: string; op: TouchOp }[]): Set<string> {
  return new Set(files.filter((f) => f.op !== "read").map((f) => f.path));
}

const [touchedPaths, setTouchedPathsSignal] = createSignal<ReadonlySet<string>>(new Set());
export { touchedPaths };

/// Called by Editor (the sole owner of the selected session's touched fetch)
/// on selection change and on every turn-end refresh.
export function setTouchedPaths(paths: ReadonlySet<string>) {
  setTouchedPathsSignal(paths);
}

/** True if the selected session wrote `path` (absolute). */
export function isTouched(path: string): boolean {
  return touchedPaths().has(path);
}
