// Where a file a reply names lives, as far as Tori can tell: in the workspace
// the reply was written in, in another worktree Tori tracks, or nowhere it knows.

import { emitWith, NAVIGATE, type NavTarget } from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";
import { openFile, opensInDefaultApp } from "../../utils/pathActions";
import { folderOwner, unitOwning } from "../../utils/sessionActivity";
import { topics } from "../../utils/topicStore";
import { rootOf, topicRoots } from "../../utils/topics";

export type FilePlace = { kind: "here" } | { kind: "worktree"; folder: string; label: string };

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/** `here` covers a Topic's other members too: the editor already spans them,
 *  so a file in a sibling worktree opens without moving anything. */
export function placeOf(path: string, cwd: string): FilePlace | null {
  if (cwd && isUnderPath(path, cwd)) return { kind: "here" };
  const topic = cwd ? topics().find((t) => topicRoots(t).some((r) => isUnderPath(cwd, r))) : undefined;
  if (topic && rootOf(path, topicRoots(topic))) return { kind: "here" };
  const unit = unitOwning(path);
  if (!unit) return null;
  const project = folderOwner(unit.folderPath)?.projectName ?? base(unit.projectPath);
  return { kind: "worktree", folder: unit.folderPath, label: `${project} / ${unit.branch ?? base(unit.folderPath)}` };
}

/** Open `path` where it lives. A file in another worktree selects that worktree
 *  first, unless it is a kind that goes to its default app, which needs no
 *  worktree on screen. */
export function openPlaced(path: string, line: number | undefined, place: FilePlace) {
  if (place.kind === "here" || opensInDefaultApp(path)) return openFile(path, line);
  emitWith<NavTarget>(NAVIGATE, { folder: place.folder, file: path, line });
}
