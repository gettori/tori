import { findSession, trackFolders } from "./sessionStore";
import { unitAt } from "./sessionActivity";

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/** Mirrors `UnitOrigin` in src-tauri/src/unit_origins.rs. */
export type UnitOrigin = { session: string; workspace: string; at: number };

/** Brings the parent's folder into the session store, so its name resolves.
 *  Called when a person reaches for the origin, never on render: a sidebar full
 *  of markers would otherwise scan every parent folder at load. */
export function loadOrigin(origin: UnitOrigin): void {
  void trackFolders([origin.workspace]);
}

/** The parent's name, "another session" until its folder is loaded or once
 *  it is gone, and where it was working, "{project} / {branch}". */
export function madeByParts(origin: UnitOrigin): { name: string; where: string } {
  const meta = findSession(origin.session)?.session;
  const unit = unitAt(origin.workspace);
  const project = lastSegment(unit?.projectPath ?? origin.workspace);
  const branch = unit?.branch ?? meta?.branch;
  return {
    name: meta?.name || meta?.title || "another session",
    where: branch ? `${project} / ${branch}` : project,
  };
}

/** "Made by {session} in {project} / {branch}". */
export function madeByLine(origin: UnitOrigin): string {
  const { name, where } = madeByParts(origin);
  return `Made by ${name} in ${where}`;
}
