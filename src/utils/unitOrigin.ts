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

/** "Made by {session} in {project} / {branch}", "another session" until the
 *  parent's folder is loaded or when the session is gone. */
export function madeByLine(origin: UnitOrigin): string {
  const meta = findSession(origin.session)?.session;
  const name = meta?.name || meta?.title || "another session";
  const unit = unitAt(origin.workspace);
  const project = lastSegment(unit?.projectPath ?? origin.workspace);
  const branch = unit?.branch ?? meta?.branch;
  return branch ? `Made by ${name} in ${project} / ${branch}` : `Made by ${name} in ${project}`;
}
