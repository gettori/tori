import { describe, it, expect, vi, beforeEach } from "vitest";

type Target = {
  root: string;
  ready: Promise<void>;
  supports: (cap: string) => boolean;
  sync: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

let target: Target | null = null;
// Every call in order, so "did it flush before it asked" is a question about a
// sequence rather than about two counters.
let calls: string[] = [];

vi.mock("./lspClient", () => ({ lspTargetFor: () => target }));

const { prepareCallHierarchy, callLevel, rootCallHierarchy, noteCallSupport } = await import("./lspCallHierarchy");
const { callRootsFor, callsSupported, clearCallRoots, normalizeCallItems, normalizeCalls, callKey } =
  await import("../../utils/callHierarchy");

const ITEM = {
  name: "callee",
  kind: 12,
  uri: "file:///repo/dep.ts",
  range: { start: { line: 4, character: 0 }, end: { line: 9, character: 1 } },
  selectionRange: { start: { line: 4, character: 16 }, end: { line: 4, character: 22 } },
  data: { server: "private" },
};

function fakeTarget(over: Partial<Target> = {}): Target {
  return {
    root: "/repo",
    ready: Promise.resolve(),
    supports: () => true,
    sync: () => calls.push("sync"),
    request: (method) => {
      calls.push(`request ${method}`);
      return Promise.resolve([ITEM]);
    },
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  target = fakeTarget();
  clearCallRoots();
});

describe("reading the protocol's shapes", () => {
  it("turns an item into something the panel can draw and jump to", () => {
    const [item] = normalizeCallItems([ITEM]);
    expect(item).toMatchObject({
      name: "callee",
      kind: 12,
      path: "/repo/dep.ts",
      // 1-based, as the editor and `@file#L<n>` speak it.
      line: 5,
      column: 1,
      // The name, not the body: the caret lands on `callee`, not on the brace.
      selectLine: 5,
      selectColumn: 17,
    });
  });

  it("keeps the server's own item verbatim, because the next request hands it back", () => {
    // The spec's round trip is "the item you gave me", and a server may hang
    // private `data` on it. A rebuilt item drops that silently, and the level
    // request comes back empty for a reason nothing reports.
    const [item] = normalizeCallItems([ITEM]);
    expect(item.raw).toBe(ITEM);
  });

  it("reads incoming calls from `from` and outgoing from `to`", () => {
    // The two replies are different wrappers around the same item, and reading
    // the wrong field yields an empty level rather than an error - a tree that
    // simply never expands, with nothing on the wire to explain it.
    const incoming = [{ from: ITEM, fromRanges: [] }];
    const outgoing = [{ to: ITEM, fromRanges: [] }];
    expect(normalizeCalls(incoming, "incoming")).toHaveLength(1);
    expect(normalizeCalls(incoming, "outgoing")).toHaveLength(0);
    expect(normalizeCalls(outgoing, "outgoing")).toHaveLength(1);
    expect(normalizeCalls(outgoing, "incoming")).toHaveLength(0);
  });

  it("drops an unreadable entry rather than throwing", () => {
    expect(normalizeCallItems(null)).toEqual([]);
    expect(normalizeCallItems([{ name: "no uri" }, { uri: "file:///a.ts" }, ITEM])).toHaveLength(1);
  });

  it("decodes a file URI the same way the workspace bridge does", async () => {
    // `utils/callHierarchy.ts` carries its own copy of this, because importing
    // `swayWorkspace` would pull CodeMirror into the eager bundle that decides
    // whether the Calls tab exists. The copy is deliberate; the two silently
    // disagreeing about escaping is not, and a path decoded differently is a
    // row that jumps nowhere.
    const { uriToPath } = await import("./swayWorkspace");
    for (const path of ["/repo/a.ts", "/repo/my project/a b.ts", "/repo/ünïcode.ts", "/repo/100%.ts"]) {
      const uri = "file://" + path.split("/").map(encodeURIComponent).join("/");
      const [item] = normalizeCallItems([{ ...ITEM, uri }]);
      expect(item.path, uri).toBe(uriToPath(uri));
    }
  });

  it("identifies a symbol by where it is, not by what it is called", () => {
    // Two overloads share a name, and a recursive pair is only a cycle when it
    // comes back to the same place.
    const [a] = normalizeCallItems([ITEM]);
    const [b] = normalizeCallItems([{ ...ITEM, uri: "file:///repo/other.ts" }]);
    expect(callKey(a)).not.toBe(callKey(b));
  });
});

describe("rooting the hierarchy", () => {
  it("flushes the document before asking, so the position means what was typed", async () => {
    await prepareCallHierarchy("/repo/a.ts", { line: 1, character: 2 });
    expect(calls).toEqual(["sync", "request textDocument/prepareCallHierarchy"]);
  });

  it("answers null for a server with no provider, and never asks", async () => {
    target = fakeTarget({ supports: () => false });
    expect(await prepareCallHierarchy("/repo/a.ts", { line: 0, character: 0 })).toBe(null);
    expect(calls).toEqual([]);
  });

  it("separates 'no provider' from 'nothing here', because the tab turns on it", async () => {
    // `null` hides the tab; `[]` shows it so the panel can say the caret is not
    // on anything callable. Collapsing the two would make "this language cannot
    // do this" and "point at a function" the same message.
    target = fakeTarget({ request: () => Promise.resolve([]) });
    await rootCallHierarchy("/repo/a.ts", { line: 0, character: 0 });
    expect(callsSupported("/repo/a.ts")).toBe(true);
    expect(callRootsFor("/repo/a.ts")).toEqual([]);

    target = fakeTarget({ supports: () => false });
    await rootCallHierarchy("/repo/b.ts", { line: 0, character: 0 });
    expect(callsSupported("/repo/b.ts")).toBe(false);
  });

  it("discards a slower reply for an earlier root", async () => {
    // Switch the root twice quickly and the first reply lands last: the panel
    // then shows a tree correctly rooted at the symbol you were looking at a
    // moment ago, every row jumping to a real place. It looks like it worked.
    const replies: ((value: unknown) => void)[] = [];
    target = fakeTarget({ request: () => new Promise((resolve) => replies.push(resolve)) });

    const first = rootCallHierarchy("/repo/a.ts", { line: 1, character: 0 });
    const second = rootCallHierarchy("/repo/a.ts", { line: 9, character: 0 });
    for (let i = 0; i < 8; i++) await Promise.resolve();

    replies[1]([{ ...ITEM, name: "newer" }]);
    replies[0]([{ ...ITEM, name: "older" }]);

    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(callRootsFor("/repo/a.ts").map((i) => i.name)).toEqual(["newer"]);
  });

  it("decides the tab's existence without asking the server anything", async () => {
    // The tab's visibility is worth no request: `callHierarchyProvider` is
    // already in the `initialize` reply. Rooting is the request, and it only
    // happens while the panel is open - without this split, every caret settle
    // in every buffer cost a `prepareCallHierarchy` nobody was looking at.
    await noteCallSupport("/repo/a.ts");
    expect(calls).toEqual([]);
    expect(callsSupported("/repo/a.ts")).toBe(true);
    expect(callRootsFor("/repo/a.ts")).toEqual([]);

    target = fakeTarget({ supports: () => false });
    await noteCallSupport("/repo/b.ts");
    expect(calls).toEqual([]);
    expect(callsSupported("/repo/b.ts")).toBe(false);
  });

  it("does not note support for a file whose tab closed while initialize settled", async () => {
    await noteCallSupport("/repo/a.ts", () => false);
    expect(callsSupported("/repo/a.ts")).toBe(false);
  });

  it("does not publish for a file whose tab closed while the server answered", async () => {
    await rootCallHierarchy("/repo/a.ts", { line: 0, character: 0 }, () => false);
    // Publishing would put back an entry the close already dropped, and nothing
    // would drop it again.
    expect(callsSupported("/repo/a.ts")).toBe(false);
  });
});

describe("expanding a level", () => {
  it("hands the server back its own item", async () => {
    let sent: unknown;
    target = fakeTarget({
      request: (method, params) => {
        calls.push(`request ${method}`);
        sent = params;
        return Promise.resolve([{ from: ITEM, fromRanges: [] }]);
      },
    });
    const [item] = normalizeCallItems([ITEM]);
    await callLevel(item, "incoming");
    expect(sent).toEqual({ item: ITEM });
  });

  it("asks the method the direction names", async () => {
    const [item] = normalizeCallItems([ITEM]);
    await callLevel(item, "incoming");
    await callLevel(item, "outgoing");
    expect(calls.filter((c) => c.startsWith("request"))).toEqual([
      "request callHierarchy/incomingCalls",
      "request callHierarchy/outgoingCalls",
    ]);
  });

  it("does not flush the document, because it asks about an item and not a position", async () => {
    // Flushing buys nothing here and would make every expansion in a deep tree
    // wait on a document round trip.
    const [item] = normalizeCallItems([ITEM]);
    await callLevel(item, "incoming");
    expect(calls).not.toContain("sync");
  });

  it("answers an empty level rather than throwing when the request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    target = fakeTarget({ request: () => Promise.reject(new Error("boom")) });
    const [item] = normalizeCallItems([ITEM]);
    expect(await callLevel(item, "incoming")).toEqual([]);
    warn.mockRestore();
  });
});
