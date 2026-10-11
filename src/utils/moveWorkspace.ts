// Folders that moved with nothing in them closed, so every per-workspace store
// follows rather than drops. Stored records are rewritten here and the live
// owners hear WORKSPACE_MOVED, the same split as `purgeWorkspace`.

import { WORKSPACE_MOVED, emitWith, type WorkspaceMoved } from "./events";
import { WORKSPACE_STORES } from "./purgeWorkspace";

export type PathMove = { from: string; to: string };

/** `path` rewritten by the deepest move that holds it, or null. */
export function movedPath(path: string, moves: readonly PathMove[]): string | null {
  let best: PathMove | null = null;
  for (const m of moves) {
    const holds = path === m.from || path.startsWith(`${m.from}/`);
    if (holds && (!best || m.from.length > best.from.length)) best = m;
  }
  return best ? best.to + path.slice(best.from.length) : null;
}

/** Every key and string in a plain JSON value, rewritten through `moves`. */
export function moveDeep<T>(value: T, moves: readonly PathMove[]): T {
  if (typeof value === "string") return (movedPath(value, moves) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => moveDeep(v, moves)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [movedPath(k, moves) ?? k, moveDeep(v, moves)]),
    ) as T;
  }
  return value;
}

export function moveStoredWorkspaces(moves: readonly PathMove[]): void {
  for (const store of WORKSPACE_STORES) {
    try {
      const raw = localStorage.getItem(store);
      if (!raw) continue;
      localStorage.setItem(store, JSON.stringify(moveDeep(JSON.parse(raw), moves)));
    } catch {
      // A store this build cannot parse is not this sweep's to fix.
    }
  }
}

export function moveWorkspaces(moves: readonly PathMove[]): void {
  moveStoredWorkspaces(moves);
  emitWith<WorkspaceMoved>(WORKSPACE_MOVED, { moves: [...moves] });
}
