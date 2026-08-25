// Sweep a workspace key out of every per-workspace store. A Feature's key
// (`feature:<id>`) is not a path, so the path purge cannot reach it: the
// stores that hold their record live drop it on PURGE_WORKSPACE, and the ones
// that only load at mount are rewritten here so a relaunch does not revive it.

import { PURGE_WORKSPACE, emitWith, type PurgeWorkspace } from "./events";

/** localStorage stores shaped `Record<workspace, ...>` at the top level. */
const WORKSPACE_STORES = [
  "sway.panes.v1",
  "sway.tabpanes.v1",
  "sway.editor.tabs.v1",
  "sway.terminalTabs",
  "sway.fileFrecency",
  "sway.bookmarks",
  "sway.breakpoints",
  "sway.watches",
  "sway.debugAttachPorts",
  "sway.debugLastTarget",
  "sway.taskRuns",
  "sway.searchHistory",
  "sway.savedSearches",
] as const;

export function dropWorkspaceKey<T extends Record<string, unknown>>(store: T, ws: string): T {
  if (!(ws in store)) return store;
  const { [ws]: _gone, ...rest } = store;
  return rest as T;
}

/** Rewrite every stored record without `ws`. Pure localStorage; no signal
 *  learns of it, which is what the event below is for. */
export function purgeStoredWorkspace(ws: string): void {
  for (const key of WORKSPACE_STORES) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !(ws in parsed)) continue;
      localStorage.setItem(key, JSON.stringify(dropWorkspaceKey(parsed, ws)));
    } catch {
      // A store this build cannot parse is not this sweep's to fix.
    }
  }
}

/** Stored sweep first, then the live owners, so a store that persists on
 *  change after dropping the key writes a record that no longer has it. */
export function purgeWorkspace(ws: string): void {
  purgeStoredWorkspace(ws);
  emitWith<PurgeWorkspace>(PURGE_WORKSPACE, { workspace: ws });
}

/** Every stored record that still holds `ws`, for a test or a doctor. */
export function storesHolding(ws: string): string[] {
  const out: string[] = [];
  for (const key of WORKSPACE_STORES) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
      if (parsed && typeof parsed === "object" && ws in parsed) out.push(key);
    } catch {
      // unparseable: cannot hold it in a shape this sweep knows
    }
  }
  return out;
}
