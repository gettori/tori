// A project's open pull requests, held outside whatever is drawing them.
//
// ## Why a store and not component state
//
// The list is drawn in two places, the right pane's Pull Requests mode and its
// own tab in the stage, and in the pane it is *replaced* by the pull request
// somebody opens rather than sitting beside it. State held in the list would go
// with it: coming back would re-ask for a list nothing had changed, and a merge
// landed from the detail view would have nowhere to report itself, because the
// thing that needs to know is not mounted at the moment it happens.
//
// So the entry outlives every view of it, the same arrangement and for the same
// reasons as `prReviewStore`. `ensure(root)` is what a view calls on mount and
// costs nothing on a root already read; `reload(root)` is for the things that
// make a listing wrong, and works whether or not anyone is looking.
//
// Uncached in Rust on purpose: `forge_list_prs` bypasses the poll layer's
// pacing, which exists for a tick that runs forever and not for a click.

import { createStore, reconcile } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { forgeErrorMessage, type Paged, type PullRequest } from "./forgeTypes";

export type PrListEntry = {
  items: PullRequest[];
  /** The repo has more open pull requests than one listing carries. A short
   *  list rendered as a complete one is the failure nobody reports. */
  truncated: boolean;
  loading: boolean;
  error: string | null;
};

const blank = (): PrListEntry => ({ items: [], truncated: false, loading: false, error: null });

const EMPTY = blank();

const [entries, setEntries] = createStore<Record<string, PrListEntry>>({});

/** Roots `ensure` has already read, so remounting a view is free. */
const read = new Set<string>();

/// Which read of a root is current.
///
/// Two views of one project can each ask, and a Refresh can overtake the load a
/// mount started. Without this the slower answer wins, which on a Refresh after
/// a merge is the stale list arriving last.
const seq = new Map<string, number>();

/** Everything held for one project. A root nobody has asked about reads blank
 *  rather than undefined, so a view mounting before its `ensure` lands has the
 *  same shape as one whose read failed. */
export function prListEntry(root: string): PrListEntry {
  return entries[root] ?? EMPTY;
}

/** Read this project's pull requests, once, however many views ask. */
export function ensurePrList(root: string): void {
  if (read.has(root)) return;
  void reloadPrList(root);
}

/// Ask again, now.
///
/// For everything that makes a listing wrong from outside it: a Refresh, a pull
/// request opened from the Changes panel, a merge landed in the detail view, a
/// credential that has just started working again. Nothing here decides *when*,
/// because each of those knows something this does not.
export async function reloadPrList(root: string): Promise<void> {
  read.add(root);
  const mine = (seq.get(root) ?? 0) + 1;
  seq.set(root, mine);
  if (!entries[root]) setEntries(root, blank());
  setEntries(root, { loading: true, error: null });
  try {
    const page = await invoke<Paged<PullRequest>>("forge_list_prs", { projectPath: root });
    if (seq.get(root) !== mine) return;
    setEntries(root, { items: page.items, truncated: page.truncated });
  } catch (e) {
    if (seq.get(root) !== mine) return;
    // Emptied, unlike a failed files read. A listing that failed has no partial
    // answer worth keeping: whatever is in hand describes a moment the caller
    // has already been told this read could not confirm.
    setEntries(root, { items: [], truncated: false, error: forgeErrorMessage(e) });
  } finally {
    if (seq.get(root) === mine) setEntries(root, "loading", false);
  }
}

/// Give up what is held for a project.
///
/// For a credential that has stopped working. What is in hand was fetched by an
/// account that may no longer be the one this repo uses, so it is dropped rather
/// than shown behind the notice explaining why nothing can be fetched.
export function forgetPrList(root: string): void {
  read.delete(root);
  seq.delete(root);
  if (entries[root]) setEntries(root, reconcile(blank()));
}

/** Test seam: this outlives any one component. */
export function resetPrListStoreForTests(): void {
  read.clear();
  seq.clear();
  setEntries(reconcile({}));
}
