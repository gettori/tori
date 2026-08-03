import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
  flattenSymbols,
  symbolKindName,
  symbolClientCapabilities,
  symbols,
  publishSymbols,
  dropSymbols,
  clearSymbols,
  symbolsFor,
  symbolsSupported,
  setWorkspaceSymbolSearch,
  searchWorkspaceSymbols,
  MAX_SYMBOLS,
  type SymbolNode,
} from "./symbols";

// A server answers `textDocument/documentSymbol` in one of two shapes and is
// free to pick either. The whole point of this module is that nothing
// downstream has to know which one it got, so most of what is asserted here is
// that the two fixtures below - the same file, described both ways - come out
// as the same tree.

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

const PATH = "/proj/src/thing.ts";
const URI = "file:///proj/src/thing.ts";

// class Thing { go() {…} }  …  function helper() {…}
const HIERARCHICAL = [
  {
    name: "Thing",
    detail: "class",
    kind: 5,
    range: range(0, 0, 6, 1),
    selectionRange: range(0, 6, 0, 11),
    children: [
      {
        name: "go",
        kind: 6,
        range: range(1, 2, 3, 3),
        selectionRange: range(1, 2, 1, 4),
      },
    ],
  },
  {
    name: "helper",
    kind: 12,
    range: range(8, 0, 10, 1),
    selectionRange: range(8, 9, 8, 15),
  },
];

// The same file, as a server that never got `hierarchicalDocumentSymbolSupport`
// would describe it: one list, no nesting, a `containerName` string instead.
const FLAT = [
  { name: "Thing", kind: 5, location: { uri: URI, range: range(0, 0, 6, 1) } },
  { name: "go", kind: 6, containerName: "Thing", location: { uri: URI, range: range(1, 2, 3, 3) } },
  { name: "helper", kind: 12, location: { uri: URI, range: range(8, 0, 10, 1) } },
];

/** Name, kind, start line and nesting: everything the two shapes must agree on.
 *  They legitimately differ on the two things the flat form cannot carry (a
 *  selection range, a detail string) and the one the tree form does not need
 *  (a container name), so those are asserted separately below. */
function shape(nodes: SymbolNode[]): unknown {
  return nodes.map((n) => ({ name: n.name, kind: n.kind, line: n.line, children: shape(n.children) }));
}

describe("normalizeDocumentSymbols", () => {
  it("reads the hierarchical shape as the tree it already is", () => {
    const tree = normalizeDocumentSymbols(HIERARCHICAL, PATH);
    expect(shape(tree)).toEqual([
      { name: "Thing", kind: 5, line: 1, children: [{ name: "go", kind: 6, line: 2, children: [] }] },
      { name: "helper", kind: 12, line: 9, children: [] },
    ]);
  });

  it("rebuilds the same tree from the flat shape", () => {
    expect(shape(normalizeDocumentSymbols(FLAT, PATH))).toEqual(
      shape(normalizeDocumentSymbols(HIERARCHICAL, PATH)),
    );
  });

  it("nests by range, not by containerName", () => {
    // Two methods called `go` on two classes. Matching names would put both
    // under whichever class was seen first; containment cannot get this wrong.
    const flat = [
      { name: "A", kind: 5, location: { uri: URI, range: range(0, 0, 3, 1) } },
      { name: "go", kind: 6, containerName: "A", location: { uri: URI, range: range(1, 2, 2, 3) } },
      { name: "B", kind: 5, location: { uri: URI, range: range(5, 0, 8, 1) } },
      { name: "go", kind: 6, containerName: "A", location: { uri: URI, range: range(6, 2, 7, 3) } },
    ];
    const tree = normalizeDocumentSymbols(flat, PATH);
    expect(tree.map((n) => n.name)).toEqual(["A", "B"]);
    expect(tree[0].children[0].line).toBe(2);
    expect(tree[1].children[0].line).toBe(7);
  });

  it("puts the caret on the name, not on the body", () => {
    const [thing] = normalizeDocumentSymbols(HIERARCHICAL, PATH);
    // `class Thing` - the range starts at column 1, the name at column 7.
    expect(thing.line).toBe(1);
    expect(thing.column).toBe(1);
    expect(thing.selectColumn).toBe(7);
  });

  it("falls back to the symbol's start when there is no selection range", () => {
    const [thing] = normalizeDocumentSymbols(FLAT, PATH);
    expect(thing.selectLine).toBe(thing.line);
    expect(thing.selectColumn).toBe(thing.column);
  });

  it("keeps the flat shape's containerName, which is all it has to say where a symbol is", () => {
    const go = flattenSymbols(normalizeDocumentSymbols(FLAT, PATH)).find((n) => n.name === "go");
    expect(go?.container).toBe("Thing");
  });

  it("converts to 1-based line and column, as the editor speaks them", () => {
    const [, helper] = normalizeDocumentSymbols(HIERARCHICAL, PATH);
    expect(helper.line).toBe(9); // LSP line 8
    expect(helper.selectColumn).toBe(10); // LSP character 9
    expect(helper.endLine).toBe(11);
  });

  it("orders the top level and each child list by position", () => {
    const jumbled = [HIERARCHICAL[1], HIERARCHICAL[0]];
    expect(normalizeDocumentSymbols(jumbled, PATH).map((n) => n.name)).toEqual(["Thing", "helper"]);
  });

  it("stamps every node with the file it was asked about", () => {
    for (const n of flattenSymbols(normalizeDocumentSymbols(HIERARCHICAL, PATH))) {
      expect(n.path).toBe(PATH);
    }
  });

  it("answers empty for null, a non-array, and an empty reply", () => {
    expect(normalizeDocumentSymbols(null, PATH)).toEqual([]);
    expect(normalizeDocumentSymbols({ nope: true }, PATH)).toEqual([]);
    expect(normalizeDocumentSymbols([], PATH)).toEqual([]);
  });

  it("drops an entry with no name or no range rather than rendering a blank row", () => {
    const res = [
      { name: "", kind: 12, range: range(0, 0, 1, 0), selectionRange: range(0, 0, 0, 1) },
      { name: "nowhere", kind: 12 },
      { name: "real", kind: 12, range: range(2, 0, 3, 0), selectionRange: range(2, 0, 2, 4) },
    ];
    expect(normalizeDocumentSymbols(res, PATH).map((n) => n.name)).toEqual(["real"]);
  });

  it("caps a generated file rather than handing thousands of rows to a panel", () => {
    const many = Array.from({ length: MAX_SYMBOLS + 50 }, (_, i) => ({
      name: `s${i}`,
      kind: 13,
      range: range(i, 0, i, 5),
      selectionRange: range(i, 0, i, 5),
    }));
    expect(normalizeDocumentSymbols(many, PATH)).toHaveLength(MAX_SYMBOLS);
  });

  it("caps the nodes, not just the reply's top level", () => {
    // A cap on the response array alone would let this straight through: it is
    // one entry, and every symbol in the file is a child of it.
    const huge = [
      {
        name: "Everything",
        kind: 2,
        range: range(0, 0, MAX_SYMBOLS + 100, 0),
        selectionRange: range(0, 0, 0, 10),
        children: Array.from({ length: MAX_SYMBOLS + 100 }, (_, i) => ({
          name: `m${i}`,
          kind: 6,
          range: range(i + 1, 2, i + 1, 8),
          selectionRange: range(i + 1, 2, i + 1, 8),
        })),
      },
    ];
    const tree = normalizeDocumentSymbols(huge, PATH);
    expect(flattenSymbols(tree)).toHaveLength(MAX_SYMBOLS);
    // What survives is the top of the file, each kept node still under its
    // parent, rather than an arbitrary slice with orphans in it.
    expect(tree[0].name).toBe("Everything");
    expect(tree[0].children[0].name).toBe("m0");
  });
});

describe("normalizeWorkspaceSymbols", () => {
  const toPath = (uri: string) => (uri.startsWith("file://") ? uri.slice("file://".length) : null);

  it("stays flat, because hits from unrelated files have no tree to sit in", () => {
    const res = [
      { name: "Thing", kind: 5, location: { uri: URI, range: range(0, 0, 6, 1) } },
      { name: "go", kind: 6, containerName: "Thing", location: { uri: URI, range: range(1, 2, 3, 3) } },
    ];
    const hits = normalizeWorkspaceSymbols(res, toPath);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.children.length === 0)).toBe(true);
  });

  it("resolves each hit to a path, so Enter has somewhere to go", () => {
    const res = [{ name: "Thing", kind: 5, location: { uri: URI, range: range(0, 0, 6, 1) } }];
    expect(normalizeWorkspaceSymbols(res, toPath)[0].path).toBe("/proj/src/thing.ts");
  });

  it("drops a hit Sway cannot address rather than listing a dead row", () => {
    // A server may answer about something with no file behind it at all -
    // `untitled:`, or a jar/zip scheme. Listing it would mean an Enter that
    // does nothing and says nothing.
    const res = [
      { name: "Ghost", kind: 5, location: { uri: "untitled:Untitled-1", range: range(0, 0, 1, 0) } },
      { name: "Real", kind: 5, location: { uri: URI, range: range(0, 0, 1, 0) } },
    ];
    expect(normalizeWorkspaceSymbols(res, toPath).map((h) => h.name)).toEqual(["Real"]);
  });

  it("answers empty for a null reply", () => {
    expect(normalizeWorkspaceSymbols(null, toPath)).toEqual([]);
  });
});

describe("flattenSymbols", () => {
  it("walks depth-first, parents before children", () => {
    const tree = normalizeDocumentSymbols(HIERARCHICAL, PATH);
    expect(flattenSymbols(tree).map((n) => n.name)).toEqual(["Thing", "go", "helper"]);
  });
});

describe("symbolKindName", () => {
  it("names the kinds the protocol defines", () => {
    expect(symbolKindName(5)).toBe("Class");
    expect(symbolKindName(12)).toBe("Function");
  });

  it("labels a kind it has never heard of rather than dropping the symbol", () => {
    expect(symbolKindName(99)).toBe("Symbol");
  });
});

describe("symbolClientCapabilities", () => {
  // The library advertises neither, and a conformant server offers no provider
  // for something the client never asked for - so this object is the whole
  // reason an outline exists at all.
  it("asks for document symbols, hierarchically", () => {
    const doc = symbolClientCapabilities.clientCapabilities.textDocument.documentSymbol;
    expect(doc.hierarchicalDocumentSymbolSupport).toBe(true);
    expect(doc.symbolKind.valueSet).toContain(5);
  });

  it("asks for workspace symbols", () => {
    expect(symbolClientCapabilities.clientCapabilities.workspace.symbol).toBeTruthy();
  });

  it("invites no server-initiated request", () => {
    // This client answers those with -32601, and the absence of dynamic
    // registration is also what keeps servers watching files themselves.
    const caps = symbolClientCapabilities.clientCapabilities as Record<string, Record<string, unknown>>;
    expect(caps.workspace.configuration).toBeUndefined();
    expect(caps.workspace.didChangeWatchedFiles).toBeUndefined();
  });
});

describe("the store", () => {
  beforeEach(() => clearSymbols());

  it("hands a file's tree back to whoever asks", () => {
    const tree = normalizeDocumentSymbols(HIERARCHICAL, PATH);
    publishSymbols(PATH, tree);
    expect(symbolsFor(PATH).map((n) => n.name)).toEqual(["Thing", "helper"]);
    expect(symbolsSupported(PATH)).toBe(true);
  });

  it("tells 'no provider' apart from 'not asked yet'", () => {
    // Both show no outline, but only the first is an answer. The tab appears on
    // the answer, so a file whose server is still starting must not count.
    expect(symbolsSupported(PATH)).toBe(false);
    publishSymbols(PATH, null);
    expect(symbolsSupported(PATH)).toBe(false);
    publishSymbols(PATH, []);
    expect(symbolsSupported(PATH)).toBe(true);
    expect(symbolsFor(PATH)).toEqual([]);
  });

  it("is empty for a null path, which is what an editor with no tabs has", () => {
    expect(symbolsFor(null)).toEqual([]);
    expect(symbolsSupported(null)).toBe(false);
  });

  it("forgets a closed file", () => {
    publishSymbols(PATH, []);
    dropSymbols(PATH);
    expect(symbolsSupported(PATH)).toBe(false);
    expect(PATH in symbols()).toBe(false);
  });

  it("leaves the store alone when told to drop a path it never held", () => {
    publishSymbols(PATH, []);
    const before = symbols();
    dropSymbols("/proj/other.ts");
    expect(symbols()).toBe(before);
  });

  it("forgets everything on a project switch", () => {
    publishSymbols(PATH, []);
    publishSymbols("/proj/other.ts", []);
    clearSymbols();
    expect(Object.keys(symbols())).toEqual([]);
  });
});

describe("workspace search registration", () => {
  it("answers empty when no editor is mounted", async () => {
    // Which is the state every non-editor test is in, and the honest answer:
    // there is no server running to ask.
    await expect(searchWorkspaceSymbols("Thing")).resolves.toEqual([]);
  });

  it("routes through the registered search", async () => {
    const off = setWorkspaceSymbolSearch(async (q) =>
      normalizeDocumentSymbols([{ name: q, kind: 5, range: range(0, 0, 1, 0), selectionRange: range(0, 0, 0, 1) }], PATH),
    );
    await expect(searchWorkspaceSymbols("Thing").then((r) => r.map((n) => n.name))).resolves.toEqual([
      "Thing",
    ]);
    off();
    await expect(searchWorkspaceSymbols("Thing")).resolves.toEqual([]);
  });

  it("ignores a stale unregister, so a remount is not undone by the old editor", async () => {
    const offOld = setWorkspaceSymbolSearch(async () => []);
    setWorkspaceSymbolSearch(async () =>
      normalizeDocumentSymbols([{ name: "new", kind: 5, range: range(0, 0, 1, 0), selectionRange: range(0, 0, 0, 1) }], PATH),
    );
    offOld();
    await expect(searchWorkspaceSymbols("x").then((r) => r.length)).resolves.toBe(1);
  });
});
