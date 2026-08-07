// Asking a running server for a call hierarchy.
//
// The half that needs a live client, kept out of `utils/callHierarchy.ts` for
// `lspSymbols.ts`'s reason: that module is on the eager path (`Editor.tsx` reads
// it to decide whether the Calls tab exists) and one runtime `@codemirror/*`
// import there would put the whole editor graph back in the startup chunk.
// Everything here decides who to ask and what a refusal means; the shapes are
// normalised over there.

import {
  callKey,
  normalizeCallItems,
  normalizeCalls,
  publishCallRoots,
  type CallDirection,
  type CallItem,
} from "../../utils/callHierarchy";
import { lspTargetFor } from "./lspClient";
import { pathToUri } from "./swayWorkspace";

/**
 * Root the hierarchy at `position` in `path`.
 *
 * Returns the items without publishing, so the guard below is the only thing
 * that publishes. Null distinguishes "this server does not do call hierarchy"
 * from an empty array, which is "it does, and the caret is not on anything
 * callable" - the two states the tab's visibility turns on.
 */
export async function prepareCallHierarchy(
  path: string,
  position: { line: number; character: number },
): Promise<CallItem[] | null> {
  const target = lspTargetFor(path);
  if (!target) return null;
  // Waiting rather than refusing: a file opened the moment its server came up
  // arrives here before `initialize` was answered, and refusing then would make
  // the tab's existence depend on how fast the server started.
  await target.ready;
  if (!target.supports("callHierarchyProvider")) return null;
  // A prepare is a question about a *position*, so the server has to be looking
  // at the document that position is in. The library's own sync is debounced by
  // 500 ms, so typing and asking sooner would be answered against text it has
  // not seen.
  target.sync();
  try {
    const res = await target.request<unknown>("textDocument/prepareCallHierarchy", {
      textDocument: { uri: pathToUri(path) },
      position,
    });
    return normalizeCallItems(res);
  } catch (e) {
    console.warn("prepareCallHierarchy failed", path, e);
    return null;
  }
}

/**
 * One level below `item`.
 *
 * No `sync()` here, deliberately: this asks about an *item* the server already
 * handed back, not about a position in a document, so flushing buys nothing and
 * would make every expansion in a large tree wait on a document round trip.
 */
export async function callLevel(item: CallItem, direction: CallDirection): Promise<CallItem[]> {
  const target = lspTargetFor(item.path);
  if (!target) return [];
  await target.ready;
  if (!target.supports("callHierarchyProvider")) return [];
  const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
  try {
    // The server's own item, handed back verbatim. The spec's round trip is
    // "the item you gave me", and a rebuilt one drops whatever private `data`
    // the server hung on it.
    const res = await target.request<unknown>(method, { item: item.raw });
    return normalizeCalls(res, direction);
  } catch (e) {
    console.warn(`${method} failed`, item.path, e);
    return [];
  }
}

// One token per file with a prepare outstanding. Deleted by whichever finishes
// latest, so this holds only what is genuinely in flight.
const pending = new Map<string, number>();

/**
 * Root the hierarchy for `path` at `position` and publish it, unless a newer
 * ask for the same file has been made since.
 *
 * Publishing lives inside the guard, the way `refreshDocumentSymbols` does it,
 * because that is what makes the guard unskippable: there is no way to root
 * without going through it. The failure it prevents is specific and looks like
 * success - switch the root twice quickly, the slower first reply lands last,
 * and the panel shows a tree correctly rooted at the symbol you were looking at
 * a moment ago, with every row jumping to a real place.
 *
 * Keyed on the file rather than on the position: there is one Calls panel and
 * one active file, so a newer root anywhere in it supersedes an older one.
 * Keying on the position would give two positions two keys and let neither
 * supersede the other, which is exactly the case this exists for.
 */
export async function rootCallHierarchy(
  path: string,
  position: { line: number; character: number },
  stillOpen: () => boolean = () => true,
): Promise<boolean> {
  const token = (pending.get(path) ?? 0) + 1;
  pending.set(path, token);

  const items = await prepareCallHierarchy(path, position);

  if (pending.get(path) !== token) return false;
  pending.delete(path);
  // The tab closed while the server was answering. Publishing now would put
  // back an entry the close already dropped, and nothing would drop it again.
  if (!stillOpen()) return false;
  publishCallRoots(path, items);
  return true;
}

/**
 * Record whether this file's server does call hierarchy at all, without asking
 * it anything.
 *
 * This is what the Calls tab's visibility is made of, and it deliberately
 * issues no request: `callHierarchyProvider` is already in the `initialize`
 * reply, so the answer is free. Rooting - which *is* a request - then only has
 * to happen while somebody is looking at the panel.
 *
 * Publishes `[]` for a supporting server, which shows the tab with nothing in
 * it yet; the panel's empty state is what tells the user to point at a
 * function. `null` hides the tab.
 */
export async function noteCallSupport(path: string, stillOpen: () => boolean = () => true): Promise<void> {
  const target = lspTargetFor(path);
  if (!target) {
    publishCallRoots(path, null);
    return;
  }
  await target.ready;
  if (!stillOpen()) return;
  publishCallRoots(path, target.supports("callHierarchyProvider") ? [] : null);
}

/** The fetcher the panel calls to expand a row. Registered by the editor. */
export function callFetcher(item: CallItem, direction: CallDirection): Promise<CallItem[]> {
  return callLevel(item, direction);
}

export { callKey };
