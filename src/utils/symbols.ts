// The symbol store, and the one shape every symbol surface reads.
//
// A language server answers `textDocument/documentSymbol` in either of two
// shapes, and which one it picks is not something a panel should have to know:
//
//   * **hierarchical** `DocumentSymbol[]`, already a tree, each node carrying a
//     full `range` plus the narrower `selectionRange` that is the name itself;
//   * **flat** `SymbolInformation[]`, one list with a `containerName` string and
//     no nesting at all.
//
// Both are normalised here into one `SymbolNode` tree, so the outline, the
// palette's `@` mode and (later) breadcrumbs all consume the same thing.
//
// This module must stay free of runtime CodeMirror imports, for the same reason
// `diagnostics.ts` must: `Editor.tsx` imports it eagerly to decide whether the
// Outline tab exists at all, and one `@codemirror/*` value import here would
// drag the editor's ~1.3 MB dependency graph into the startup chunk and undo the
// lazy boundary around `CodeEditor`. The half that needs a live client lives in
// `panels/Editor/lspSymbols.ts`.

import { createSignal } from "solid-js";

/** LSP `SymbolKind`. The wire values, so a response needs no translation. */
export const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/** A server may send a kind this client has never heard of; it is still a
 *  symbol, and hiding it would be worse than labelling it plainly. */
export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? "Symbol";
}

export type SymbolNode = {
  name: string;
  /** The server's own annotation (a signature, a type), or null. */
  detail: string | null;
  /** LSP `SymbolKind`. */
  kind: number;
  /** Absolute path of the file this symbol is in. */
  path: string;
  /** The symbol's whole extent, 1-based, as the editor and `@file#L<n>` speak
   *  it. Wave 6's breadcrumbs need this to ask which symbol holds the caret. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** Where to put the caret when this symbol is revealed: the name, not the
   *  body. Equal to `line`/`column` for the flat shape, which has no separate
   *  selection range. */
  selectLine: number;
  selectColumn: number;
  /** The flat shape's `containerName`, or null. Kept because a workspace-symbol
   *  hit has no tree to sit in and this is the only thing saying where it is. */
  container: string | null;
  children: SymbolNode[];
};

// A generated file (a bundled .d.ts, a protobuf stub) can carry tens of
// thousands of symbols, and nothing renders or reads that many. Enforced twice,
// because either alone leaves a hole: on the response array, which bounds how
// much is normalised, and on the resulting node count, since one root with a
// hundred thousand children is a single array entry.
export const MAX_SYMBOLS = 2000;

/** The client capabilities Phases 5's surfaces need, as an `LSPClientExtension`.
 *
 *  `@codemirror/lsp-client` advertises neither: its capability const covers
 *  completion, hover, formatting, rename, signature help, the definition
 *  family, references and diagnostics, and stops there. A conformant server
 *  will not offer a provider for something the client never asked for, so
 *  without this the outline is empty against a correct server rather than
 *  against a broken one.
 *
 *  Deliberately narrow. Nothing here invites a server-initiated *request*:
 *  this client answers those with `-32601`, so `workspace.configuration` and
 *  dynamic registration stay unadvertised. */
export const symbolClientCapabilities = {
  clientCapabilities: {
    textDocument: {
      documentSymbol: {
        // Without this a server is entitled to answer in the flat shape only.
        // Both are handled below, but the tree the server already knows is
        // better than one rebuilt from ranges.
        hierarchicalDocumentSymbolSupport: true,
        symbolKind: { valueSet: Object.keys(SYMBOL_KIND_NAMES).map(Number) },
      },
    },
    workspace: {
      symbol: {
        symbolKind: { valueSet: Object.keys(SYMBOL_KIND_NAMES).map(Number) },
      },
    },
  },
};

// ---------------------------------------------------------------- normalising

type LspPos = { line: number; character: number };
type LspRange = { start: LspPos; end: LspPos };

type RawDocumentSymbol = {
  name?: unknown;
  detail?: unknown;
  kind?: unknown;
  range?: LspRange;
  selectionRange?: LspRange;
  children?: unknown;
};

type RawSymbolInformation = {
  name?: unknown;
  kind?: unknown;
  containerName?: unknown;
  location?: { uri?: unknown; range?: LspRange };
};

function isRange(r: unknown): r is LspRange {
  const v = r as LspRange | undefined;
  return (
    !!v &&
    typeof v.start?.line === "number" &&
    typeof v.start?.character === "number" &&
    typeof v.end?.line === "number" &&
    typeof v.end?.character === "number"
  );
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Whether `outer` encloses `inner`, which is what rebuilds the tree the flat
 *  shape threw away. Containment, not `containerName`: two overloads share a
 *  name, and a name is not a position. */
function contains(outer: SymbolNode, inner: SymbolNode): boolean {
  const startsAfter = outer.line < inner.line || (outer.line === inner.line && outer.column <= inner.column);
  const endsBefore =
    outer.endLine > inner.endLine || (outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn);
  return startsAfter && endsBefore;
}

function inDocumentOrder(a: SymbolNode, b: SymbolNode): number {
  return a.line - b.line || a.column - b.column || b.endLine - a.endLine;
}

/** Nest a flat list by range containment. Sorted first so an enclosing symbol
 *  always arrives before what it encloses; ties break widest-first, so a class
 *  starting on its first method's line still gets to be the parent. */
function nestByRange(flat: SymbolNode[]): SymbolNode[] {
  const sorted = [...flat].sort(inDocumentOrder);
  const roots: SymbolNode[] = [];
  const stack: SymbolNode[] = [];
  for (const node of sorted) {
    while (stack.length && !contains(stack[stack.length - 1], node)) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function fromHierarchical(raw: RawDocumentSymbol, path: string): SymbolNode | null {
  const name = str(raw.name);
  if (!name || !isRange(raw.range)) return null;
  const sel = isRange(raw.selectionRange) ? raw.selectionRange : raw.range;
  const children = Array.isArray(raw.children)
    ? (raw.children as RawDocumentSymbol[])
        .map((c) => fromHierarchical(c, path))
        .filter((c): c is SymbolNode => !!c)
        .sort(inDocumentOrder)
    : [];
  return {
    name,
    detail: str(raw.detail),
    kind: typeof raw.kind === "number" ? raw.kind : 0,
    path,
    line: raw.range.start.line + 1,
    column: raw.range.start.character + 1,
    endLine: raw.range.end.line + 1,
    endColumn: raw.range.end.character + 1,
    selectLine: sel.start.line + 1,
    selectColumn: sel.start.character + 1,
    container: null,
    children,
  };
}

function fromFlat(raw: RawSymbolInformation, path: string): SymbolNode | null {
  const name = str(raw.name);
  const range = raw.location?.range;
  if (!name || !isRange(range)) return null;
  return {
    name,
    detail: null,
    kind: typeof raw.kind === "number" ? raw.kind : 0,
    path,
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
    // The flat shape has no selection range, so the symbol's start is the best
    // caret target it can offer.
    selectLine: range.start.line + 1,
    selectColumn: range.start.character + 1,
    container: str(raw.containerName),
    children: [],
  };
}

/** Keep the first `budget` nodes depth-first, which is the order the outline
 *  draws in: what survives a cap is the top of the file, and every kept node
 *  still has its own parent above it. */
function capTree(nodes: SymbolNode[], budget: { left: number }): SymbolNode[] {
  const out: SymbolNode[] = [];
  for (const node of nodes) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    node.children = capTree(node.children, budget);
    out.push(node);
  }
  return out;
}

/** Both `textDocument/documentSymbol` shapes, as one tree.
 *
 *  The shapes are told apart by `location`, which only `SymbolInformation`
 *  carries; the spec allows a server to answer with either and says nothing
 *  about mixing them, so the first usable entry decides for the response. */
export function normalizeDocumentSymbols(res: unknown, path: string): SymbolNode[] {
  if (!Array.isArray(res)) return [];
  const list = res.slice(0, MAX_SYMBOLS);
  const flatShape = list.some((e) => isRange((e as RawSymbolInformation)?.location?.range));
  const tree = flatShape
    ? nestByRange(list.map((e) => fromFlat(e as RawSymbolInformation, path)).filter((n): n is SymbolNode => !!n))
    : list
        .map((e) => fromHierarchical(e as RawDocumentSymbol, path))
        .filter((n): n is SymbolNode => !!n)
        .sort(inDocumentOrder);
  return capTree(tree, { left: MAX_SYMBOLS });
}

/** `workspace/symbol`'s reply. Always the flat shape, always across files, so it
 *  stays a flat list: nesting hits from unrelated files under each other would
 *  invent a structure the server never claimed.
 *
 *  `toPath` is injected because turning a server's URI into a path is the
 *  editor's business, and this module may not import the module that knows how
 *  (it reaches CodeMirror). A hit Tori cannot address is dropped rather than
 *  listed as something Enter would do nothing to. */
export function normalizeWorkspaceSymbols(res: unknown, toPath: (uri: string) => string | null): SymbolNode[] {
  if (!Array.isArray(res)) return [];
  const out: SymbolNode[] = [];
  for (const entry of res.slice(0, MAX_SYMBOLS)) {
    const raw = entry as RawSymbolInformation;
    const uri = str(raw.location?.uri);
    const path = uri ? toPath(uri) : null;
    if (!path) continue;
    const node = fromFlat(raw, path);
    if (node) out.push(node);
  }
  return out;
}

/** Depth-first, parents before children: the order the outline draws and the
 *  order `@` search scores. */
export function flattenSymbols(nodes: SymbolNode[]): SymbolNode[] {
  const out: SymbolNode[] = [];
  const walk = (list: SymbolNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// -------------------------------------------------------------------- store

// Keyed by absolute path. `null` is a real and distinct answer: the file has a
// server and that server has no document-symbol provider, which is what hides
// the Outline tab. An absent key means nobody has asked yet.
const [symbols, setSymbols] = createSignal<Record<string, SymbolNode[] | null>>({});
export { symbols };

/** Publish a file's symbol tree, or `null` when its server offers none.
 *  Called by the editor, which is the only place that holds a live client. */
export function publishSymbols(path: string, nodes: SymbolNode[] | null): void {
  setSymbols((prev) => ({ ...prev, [path]: nodes }));
}

/** Forget a file. The tab closed, so nothing can render its outline and the
 *  store has no business growing for the rest of the session. */
export function dropSymbols(path: string): void {
  setSymbols((prev) => {
    if (!(path in prev)) return prev;
    const next = { ...prev };
    delete next[path];
    return next;
  });
}

/** Forget everything. A project switch: every server behind these is gone. */
export function clearSymbols(): void {
  setSymbols({});
}

/** A file's symbols, empty for one that has none or has not been asked. */
export function symbolsFor(path: string | null): SymbolNode[] {
  return (path && symbols()[path]) || [];
}

/** Whether this file's server answered with a symbol tree at all. False while
 *  the answer is still in flight, which is why the Outline tab appears rather
 *  than sitting there empty. */
export function symbolsSupported(path: string | null): boolean {
  return !!path && Array.isArray(symbols()[path]);
}

// ------------------------------------------------------- workspace-wide search

export type WorkspaceSymbolSearch = (query: string) => Promise<SymbolNode[]>;

// Registered by the mounted editor, for the same reason `liveBuffers` holds a
// buffer accessor: the palette is a sibling of the editor and must not import
// the module that owns the client. Unregistered on unmount; an unregister that
// arrives after a newer editor registered is ignored rather than clearing it.
let search: WorkspaceSymbolSearch | null = null;

/** Publish the editor's workspace-symbol search. Returns the unregister. */
export function setWorkspaceSymbolSearch(fn: WorkspaceSymbolSearch): () => void {
  search = fn;
  return () => {
    if (search === fn) search = null;
  };
}

/** Ask every live server for symbols matching `query`. Empty when no editor is
 *  mounted, which is the honest answer: no server is running to ask. */
export function searchWorkspaceSymbols(query: string): Promise<SymbolNode[]> {
  return search ? search(query) : Promise.resolve([]);
}
