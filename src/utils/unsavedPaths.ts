// Which files hold unsaved work, for a caller outside the editor that is about
// to move or remove a folder: the editor's dirty buffers, plus last quit's
// stash entries that no tab has restored yet.

import { createLent } from "../lib/lent";
import { pendingStashPaths } from "./hotExit";
import { isUnderPath } from "./pathScope";

const dirty = createLent<readonly string[]>([]);
const dirtyPaths = dirty.read;

export const lendDirtyPaths = dirty.lend;
export const publishDirtyPaths = dirty.set;

export function unsavedUnder(root: string): string[] {
  const all = new Set([...dirtyPaths(), ...pendingStashPaths()]);
  return [...all].filter((p) => isUnderPath(p, root));
}
