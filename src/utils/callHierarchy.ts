// Who calls this, and what does this call.
//
// Two questions about one symbol, and the protocol answers them in three steps:
// `textDocument/prepareCallHierarchy` turns a *position* into the item the
// server considers to be there, and then `callHierarchy/incomingCalls` and
// `outgoingCalls` take that item and walk one level. There is no "give me the
// tree" request, which is why the panel expands lazily rather than choosing a
// depth: every level is another round trip, and a server that indexes on demand
// will happily spend seconds on a level nobody looked at.
//
// Kept CodeMirror-free for `symbols.ts`'s reason: `Editor.tsx` reads the store
// to decide whether the Calls tab exists at all, and it sits on the eager side
// of the lazy `CodeEditor` boundary, so a runtime `@codemirror/*` import here is
// how the editor's graph gets back into the startup chunk. The half that holds a
// live client is `panels/Editor/lspCallHierarchy.ts`.

import { createSignal } from "solid-js";

/** Which way the tree runs from its root. */
export type CallDirection = "incoming" | "outgoing";

/**
 * One node's worth of symbol.
 *
 * `raw` is the server's own `CallHierarchyItem`, kept verbatim because the next
 * request has to hand it back: the spec's round trip is "here is the item you
 * gave me", and a server may carry private state on it (`data`) that means
 * nothing here and everything to it. Rebuilding an item from the fields below
 * would drop that silently.
 */
export type CallItem = {
  name: string;
  detail: string | null;
  /** LSP `SymbolKind`, so the panel can reuse `SymbolIcon`. */
  kind: number;
  path: string;
  /** 1-based, as the editor and `@file#L<n>` speak it. */
  line: number;
  column: number;
  /** Where to put the caret: the name, not the body. */
  selectLine: number;
  selectColumn: number;
  raw: unknown;
};

/**
 * Most nodes one level may contribute.
 *
 * A hot utility in a large repo genuinely has thousands of callers, and a panel
 * that renders them all is a panel that hangs on the symbol you are most likely
 * to ask about. Bounded per level rather than per tree, because the depth is the
 * user's choice and the width is not.
 */
export const MAX_CALLS_PER_LEVEL = 500;

/**
 * The capability block. `@codemirror/lsp-client` declares none, and a
 * conformant server offers no `callHierarchyProvider` for a client that never
 * asked - so without this the tab is hidden against a *correct* server, which
 * is the same silence [[concept_lsp_capability_contract]] is about.
 *
 * No `dynamicRegistration`: this client answers server-initiated requests with
 * `-32601`, so inviting one would be asking for a failure.
 */
export const callHierarchyClientCapabilities = {
  clientCapabilities: {
    textDocument: {
      callHierarchy: {},
    },
  },
};

function positionOf(range: unknown, fallbackLine: number, fallbackColumn: number) {
  const start = (range as { start?: { line?: unknown; character?: unknown } } | null)?.start;
  const line = typeof start?.line === "number" ? start.line + 1 : fallbackLine;
  const column = typeof start?.character === "number" ? start.character + 1 : fallbackColumn;
  return { line, column };
}

/** `file:///a%20b.ts` to `/a b.ts`. Duplicated from `toriWorkspace` rather than
 *  imported, because that module pulls CodeMirror and this one must not. */
function pathOf(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
}

function itemOf(raw: unknown): CallItem | null {
  const item = raw as {
    name?: unknown;
    detail?: unknown;
    kind?: unknown;
    uri?: unknown;
    range?: unknown;
    selectionRange?: unknown;
  } | null;
  if (!item || typeof item.name !== "string") return null;
  const path = pathOf(item.uri);
  if (!path) return null;
  const { line, column } = positionOf(item.range, 1, 1);
  const selection = positionOf(item.selectionRange, line, column);
  return {
    name: item.name,
    detail: typeof item.detail === "string" ? item.detail : null,
    kind: typeof item.kind === "number" ? item.kind : 12, // Function
    path,
    line,
    column,
    selectLine: selection.line,
    selectColumn: selection.column,
    raw,
  };
}

/** What `prepareCallHierarchy` answered, as items. */
export function normalizeCallItems(res: unknown): CallItem[] {
  if (!Array.isArray(res)) return [];
  return res
    .slice(0, MAX_CALLS_PER_LEVEL)
    .map(itemOf)
    .filter((i): i is CallItem => i !== null);
}

/**
 * What one level of `incomingCalls` or `outgoingCalls` answered.
 *
 * The two replies are different shapes around the same item: an incoming call
 * carries `from` (who calls it) and an outgoing one carries `to` (what it
 * calls). Reading the wrong field yields an empty level rather than an error,
 * which is why the direction is a parameter here instead of the caller
 * unwrapping and hoping.
 */
export function normalizeCalls(res: unknown, direction: CallDirection): CallItem[] {
  if (!Array.isArray(res)) return [];
  const key = direction === "incoming" ? "from" : "to";
  return res
    .slice(0, MAX_CALLS_PER_LEVEL)
    .map((entry) => itemOf((entry as Record<string, unknown> | null)?.[key]))
    .filter((i): i is CallItem => i !== null);
}

// -------------------------------------------------------------------- store

// Keyed by absolute path, and `null` is a real answer distinct from an absent
// key: `null` means this file's server has no `callHierarchyProvider`, which is
// what hides the tab, while absent means nobody has asked yet.
const [roots, setRoots] = createSignal<Record<string, CallItem[] | null>>({});
export { roots as callRoots };

/** Publish what a file's server prepared at the caret, or `null` when it offers
 *  no call hierarchy at all. Called by the editor, the only holder of a live
 *  client. */
export function publishCallRoots(path: string, items: CallItem[] | null): void {
  setRoots((prev) => ({ ...prev, [path]: items }));
}

/** Forget a file: its tab closed. */
export function dropCallRoots(path: string): void {
  setRoots((prev) => {
    if (!(path in prev)) return prev;
    const next = { ...prev };
    delete next[path];
    return next;
  });
}

/** Forget everything. A project switch: every server behind these is gone. */
export function clearCallRoots(): void {
  setRoots({});
}

/**
 * Whether this file's server does call hierarchy at all.
 *
 * The three states the Outline tab uses, one for one: an absent key is "not
 * asked yet" and reads as unsupported so the tab does not flicker in before the
 * answer; `null` is "asked, and this server has no provider", which keeps the
 * tab hidden; and an array - **including an empty one** - is "asked, and it
 * does", which shows the tab so the panel can say the caret is not on anything
 * callable. Hiding on empty would make "put the caret somewhere useful"
 * indistinguishable from "this language cannot do this".
 */
export function callsSupported(path: string | null): boolean {
  return !!path && Array.isArray(roots()[path]);
}

/** The roots prepared for a file, empty when there are none. */
export function callRootsFor(path: string | null): CallItem[] {
  return (path && roots()[path]) || [];
}

// --------------------------------------------------------------- level fetch

/** Ask for one level below `item`. Registered by the mounted editor, for the
 *  reason `setWorkspaceSymbolSearch` is: the panel is a sibling of the editor
 *  and must not import the module that owns the client. */
export type CallFetcher = (item: CallItem, direction: CallDirection) => Promise<CallItem[]>;

let fetcher: CallFetcher | null = null;

export function setCallFetcher(fn: CallFetcher): () => void {
  fetcher = fn;
  return () => {
    if (fetcher === fn) fetcher = null;
  };
}

/** One level below `item`, or nothing when no editor is mounted. */
export function fetchCallLevel(item: CallItem, direction: CallDirection): Promise<CallItem[]> {
  return fetcher ? fetcher(item, direction) : Promise.resolve([]);
}

/**
 * A stable identity for a symbol, for the cycle guard.
 *
 * Position rather than name: two overloads share a name, and a recursive pair
 * is only a cycle if it comes back to the same *place*. `selectLine` rather
 * than `line`, because a server may hand back a slightly different enclosing
 * range for the same symbol depending on which side asked.
 */
export function callKey(item: CallItem): string {
  return `${item.path}:${item.selectLine}:${item.selectColumn}:${item.name}`;
}
