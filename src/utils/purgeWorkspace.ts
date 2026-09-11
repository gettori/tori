// Sweep a workspace key out of every per-workspace store. A Feature's key
// (`feature:<id>`) is not a path, so the path purge cannot reach it: the
// stores that hold their record live drop it on PURGE_WORKSPACE, and the ones
// that only load at mount are rewritten here so a relaunch does not revive it.
//
// A Feature is swept under more than one key. Tabs and breakpoints key on `feature:<id>`, but the three debug stores key on the *member root*
// (that is what `DebugPanel` passes and what a paused session's `projectPath`
// is compared against), so those records survive the Feature key going. The
// roots therefore come in from the caller: `delete_feature` has already run by
// the time the sweep is called, so the record they could be re-read from is
// gone, and the sidebar row that ordered the delete still holds them.
//
// Only the debug stores are swept under a root, never the whole list. Deleting
// a Feature *offers* each worktree rather than removing it, so a member the
// user keeps can be reopened as a branch unit, and its tabs, terminals and tree
// state are keyed by that same folder. Those belong to the unit, not to the
// Feature that has gone.

import { PURGE_WORKSPACE, emitWith, type PurgeWorkspace } from "./events";

/** localStorage stores shaped `Record<workspace, ...>` at the top level. */
const WORKSPACE_STORES = [
  "sway.panes.v1",
  "sway.tabpanes.v1",
  "sway.editor.tabs.v1",
  "sway.terminalTabs",
  "sway.fileFrecency",
  "sway.breakpoints",
  "sway.watches",
  "sway.debugAttachPorts",
  "sway.debugLastTarget",
  "sway.taskRuns",
  "sway.searchHistory",
  "sway.savedSearches",
  "sway.treeExpanded.v1",
] as const;

/** The stores a Feature writes under a *member root* rather than under its own
 *  key: what a debug run remembers, and where. Everything else a member folder
 *  can appear in belongs to that folder as a branch unit. */
const MEMBER_ROOT_STORES = ["sway.watches", "sway.debugAttachPorts", "sway.debugLastTarget"] as const;

export function dropWorkspaceKey<T extends Record<string, unknown>>(store: T, ws: string): T {
  if (!(ws in store)) return store;
  const { [ws]: _gone, ...rest } = store;
  return rest as T;
}

/** Rewrite every stored record without `ws`, and the debug stores without any
 *  of `roots`. Pure localStorage; no signal learns of it, which is what the
 *  event below is for. */
export function purgeStoredWorkspace(ws: string, roots: readonly string[] = []): void {
  for (const store of WORKSPACE_STORES) {
    const memberKeyed = (MEMBER_ROOT_STORES as readonly string[]).includes(store);
    const keys = memberKeyed ? [ws, ...roots] : [ws];
    try {
      const raw = localStorage.getItem(store);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      const held = keys.filter((k) => k in parsed);
      if (!held.length) continue;
      const swept = held.reduce((rest, k) => dropWorkspaceKey(rest, k), parsed);
      localStorage.setItem(store, JSON.stringify(swept));
    } catch {
      // A store this build cannot parse is not this sweep's to fix.
    }
  }
}

/** Stored sweep first, then the live owners, so a store that persists on
 *  change after dropping the key writes a record that no longer has it.
 *
 *  `roots` are the Feature's member folders, for the debug stores that key on
 *  one. A branch unit passes none: its key already *is* its folder. */
export function purgeWorkspace(ws: string, roots: readonly string[] = []): void {
  purgeStoredWorkspace(ws, roots);
  emitWith<PurgeWorkspace>(PURGE_WORKSPACE, { workspace: ws, roots: [...roots] });
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
