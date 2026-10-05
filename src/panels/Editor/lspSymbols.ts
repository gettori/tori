// Asking a running language server for symbols.
//
// The half of the symbol story that needs a live client, kept out of
// `utils/symbols.ts` because that module is on the eager path (`Editor.tsx`
// reads it to decide whether the Outline tab exists) and one runtime
// `@codemirror/*` import there would put the whole editor graph back in the
// startup chunk. Everything here is shape-agnostic: the normalising lives over
// there, and this file only decides who to ask and what to do with a refusal.

import {
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
  publishSymbols,
  MAX_SYMBOLS,
  type SymbolNode,
} from "../../utils/symbols";
import { lspTargetFor, lspTargets } from "./lspClient";
import { pathToUri, uriToPath } from "./toriWorkspace";

/**
 * This file's symbol tree, or null when there is none to have.
 *
 * Null covers three states that are the same to a caller: no server claims this
 * language, the server claims it but advertises no `documentSymbolProvider`, or
 * the request failed. All three mean "there is no outline for this file", and
 * the surfaces that read the store hide themselves rather than showing an empty
 * panel that looks like a file with no symbols in it.
 */
export async function requestDocumentSymbols(path: string): Promise<SymbolNode[] | null> {
  const target = lspTargetFor(path);
  if (!target) return null;
  // Waiting rather than refusing: a file opened the moment its server came up
  // arrives here before `initialize` has been answered, and refusing then would
  // make the outline depend on how fast the server started.
  await target.ready;
  if (!target.supports("documentSymbolProvider")) return null;
  // The reply is a set of positions, so the server has to be looking at the
  // document those positions are in.
  target.sync();
  try {
    const res = await target.request<unknown>("textDocument/documentSymbol", {
      textDocument: { uri: pathToUri(path) },
    });
    return normalizeDocumentSymbols(res, path);
  } catch (e) {
    console.error("documentSymbol failed", path, e);
    return null;
  }
}

// One token per path with a request outstanding. Deleted by whichever request
// finishes latest, so this holds only what is genuinely in flight.
const pending = new Map<string, number>();

/**
 * Ask for `path`'s symbols and publish them, unless a newer ask for the same
 * path has been made since.
 *
 * The guard is not optional. Three things re-ask (a tab swap, a client
 * lifecycle change, and typing), a busy server can answer them out of order,
 * and an older reply landing last carries line numbers from before the last
 * edit - so the outline looks right and every row jumps to the wrong line.
 *
 * Publishing lives here rather than in the caller because that is what makes
 * the guard unskippable: there is no way to ask without going through it.
 *
 * `stillOpen` is the caller's own check that the file has not been closed while
 * the server was answering. Publishing then would put back an entry the tab
 * close already dropped, and nothing would drop it again.
 */
export async function refreshDocumentSymbols(path: string, stillOpen: () => boolean = () => true): Promise<boolean> {
  const token = (pending.get(path) ?? 0) + 1;
  pending.set(path, token);
  const nodes = await requestDocumentSymbols(path);
  if (pending.get(path) !== token) return false;
  pending.delete(path);
  if (!stillOpen()) return false;
  publishSymbols(path, nodes);
  return true;
}

/**
 * Symbols matching `query` from every live server.
 *
 * Every server, because `workspace/symbol` is scoped to the root its session
 * was started at: in a monorepo, the session for `packages/a` cannot see
 * `packages/b`, and the repo-root session (if there is one) has a different
 * compiler config. Asking all of them and merging is the only way the palette
 * sees the whole project.
 *
 * A server that refuses or times out contributes nothing rather than failing
 * the search: one dead server must not blank out the results of a live one.
 */
export async function requestWorkspaceSymbols(query: string): Promise<SymbolNode[]> {
  if (!query) return [];
  const lists = await Promise.all(
    lspTargets().map(async (target) => {
      await target.ready;
      if (!target.supports("workspaceSymbolProvider")) return [];
      try {
        const res = await target.request<unknown>("workspace/symbol", { query });
        return normalizeWorkspaceSymbols(res, uriToPath);
      } catch (e) {
        console.error("workspace/symbol failed", target.root, e);
        return [];
      }
    }),
  );
  return dedupe(lists.flat()).slice(0, MAX_SYMBOLS);
}

/** Two sessions whose roots nest see the same files, so the same symbol comes
 *  back twice. Position and name, not the object: the two servers may spell the
 *  URI differently, which is why nothing here is keyed on one. */
function dedupe(nodes: SymbolNode[]): SymbolNode[] {
  const seen = new Set<string>();
  const out: SymbolNode[] = [];
  for (const n of nodes) {
    const key = `${n.path}:${n.line}:${n.column}:${n.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}
