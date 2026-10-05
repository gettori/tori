import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import { symbolClientCapabilities } from "../../utils/symbols";

// Two separate claims, and both have to hold or the outline is empty against a
// *correct* server:
//
//   1. the capabilities Tori adds survive the library's own merge, so the
//      `initialize` that actually goes out asks for symbols;
//   2. the request layer asks the right server, and answers "no outline" rather
//      than throwing when there is none.
//
// The first is checked against the real `LSPClient` over a fake transport,
// because the merge is the library's code and a hand-rolled copy of it would
// pass while the real one did not.

type Target = {
  root: string;
  ready: Promise<void>;
  supports: (cap: string) => boolean;
  sync: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

let targets: Target[] = [];

vi.mock("./lspClient", () => ({
  lspTargetFor: (path: string) => targets.find((t) => path.startsWith(t.root)) ?? null,
  lspTargets: () => targets,
}));

const { requestDocumentSymbols, refreshDocumentSymbols, requestWorkspaceSymbols } = await import("./lspSymbols");
const { symbolsFor, symbolsSupported, clearSymbols } = await import("../../utils/symbols");

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

/** A target that answers `res` to everything, recording what it was asked. */
function target(opts: {
  root?: string;
  provides?: string[];
  res?: unknown;
  fail?: string;
}): Target & { asked: { method: string; params: unknown }[]; synced: number } {
  const asked: { method: string; params: unknown }[] = [];
  let synced = 0;
  const t = {
    root: opts.root ?? "/proj",
    ready: Promise.resolve(),
    supports: (cap: string) => (opts.provides ?? []).includes(cap),
    sync: () => {
      synced += 1;
      t.synced = synced;
    },
    request: (method: string, params: unknown) => {
      asked.push({ method, params });
      return opts.fail ? Promise.reject(new Error(opts.fail)) : Promise.resolve(opts.res ?? null);
    },
    asked,
    synced: 0,
  };
  return t;
}

beforeEach(() => {
  targets = [];
  clearSymbols();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the initialize payload", () => {
  function connectAndReadInit() {
    const sent: string[] = [];
    const handlers: ((msg: string) => void)[] = [];
    const transport: Transport = {
      send: (m) => sent.push(m),
      subscribe: (h) => handlers.push(h),
      unsubscribe: (h) => handlers.splice(handlers.indexOf(h), 1),
    };
    const client = new LSPClient({
      rootUri: "file:///proj",
      extensions: [...languageServerExtensions(), symbolClientCapabilities],
    }).connect(transport);
    const init = JSON.parse(sent[0]);
    // Answered so the client's own request timer is cleared and `initializing`
    // resolves; an unanswered initialize would reject three seconds later, into
    // nothing.
    for (const h of handlers) {
      h(JSON.stringify({ jsonrpc: "2.0", id: init.id, result: { capabilities: { documentSymbolProvider: true } } }));
    }
    return { init, client };
  }

  it("asks for document symbols and workspace symbols", async () => {
    const { init, client } = connectAndReadInit();
    expect(init.method).toBe("initialize");
    const caps = init.params.capabilities;
    expect(caps.textDocument.documentSymbol.hierarchicalDocumentSymbolSupport).toBe(true);
    expect(caps.workspace.symbol).toBeTruthy();
    await client.initializing;
  });

  it("keeps everything the library already advertised", async () => {
    // `mergeCapabilities` is a deep merge, but a shallow one would silently drop
    // the library's whole `textDocument` block the moment Tori added a key to
    // it - and every one of those is a feature that would just stop working.
    const { init, client } = connectAndReadInit();
    const td = init.params.capabilities.textDocument;
    expect(td.hover).toBeTruthy();
    expect(td.completion).toBeTruthy();
    expect(td.rename).toBeTruthy();
    expect(td.references).toBeTruthy();
    // Contributed by `serverDiagnostics()`, which is itself one of the
    // extensions being spread in.
    expect(td.publishDiagnostics).toBeTruthy();
    await client.initializing;
  });

  it("invites no server-initiated request", async () => {
    const { init, client } = connectAndReadInit();
    expect(init.params.capabilities.workspace.configuration).toBeUndefined();
    expect(init.params.capabilities.workspace.didChangeWatchedFiles).toBeUndefined();
    await client.initializing;
  });
});

describe("requestDocumentSymbols", () => {
  const PATH = "/proj/src/a.ts";
  const RES = [{ name: "Thing", kind: 5, range: range(0, 0, 4, 1), selectionRange: range(0, 6, 0, 11) }];

  it("answers null when no server claims the file", async () => {
    await expect(requestDocumentSymbols(PATH)).resolves.toBeNull();
  });

  it("answers null when the server advertises no provider", async () => {
    // Not an error and not an empty file: there is simply no outline to have,
    // and the tab hides rather than showing a panel that reads as "no symbols".
    const t = target({ provides: [], res: RES });
    targets = [t];
    await expect(requestDocumentSymbols(PATH)).resolves.toBeNull();
    expect(t.asked).toHaveLength(0);
  });

  it("returns the normalised tree when the server has one", async () => {
    targets = [target({ provides: ["documentSymbolProvider"], res: RES })];
    const tree = await requestDocumentSymbols(PATH);
    expect(tree?.map((n) => n.name)).toEqual(["Thing"]);
    expect(tree?.[0].path).toBe(PATH);
  });

  it("addresses the file by uri", async () => {
    const t = target({ provides: ["documentSymbolProvider"], res: RES });
    targets = [t];
    await requestDocumentSymbols(PATH);
    expect(t.asked[0].method).toBe("textDocument/documentSymbol");
    expect(t.asked[0].params).toEqual({ textDocument: { uri: "file:///proj/src/a.ts" } });
  });

  it("flushes the document before asking, since the reply is positions", async () => {
    // The library's own sync is debounced by 500 ms. Asking inside that window
    // gets an answer about the document as it was before the last keystroke,
    // and every line number in it is wrong by however much was typed.
    const t = target({ provides: ["documentSymbolProvider"], res: RES });
    targets = [t];
    await requestDocumentSymbols(PATH);
    expect(t.synced).toBe(1);
  });

  it("answers null rather than throwing when the request fails", async () => {
    targets = [target({ provides: ["documentSymbolProvider"], fail: "timed out" })];
    await expect(requestDocumentSymbols(PATH)).resolves.toBeNull();
  });

  it("waits for initialize rather than refusing a file opened as the server came up", async () => {
    let release!: () => void;
    const t = target({ provides: [], res: RES });
    t.ready = new Promise<void>((r) => (release = r));
    // The provider only exists once initialize has been answered, which is
    // exactly what `ready` is waiting for.
    let provided = false;
    t.supports = (cap) => provided && cap === "documentSymbolProvider";
    targets = [t];
    const pending = requestDocumentSymbols(PATH);
    provided = true;
    release();
    expect((await pending)?.map((n) => n.name)).toEqual(["Thing"]);
  });
});

describe("refreshDocumentSymbols", () => {
  const PATH = "/proj/src/a.ts";

  /** A target whose replies are released one at a time, so a test can land them
   *  in an order the servers chose rather than the order they were asked in. */
  function slowTarget() {
    const queue: (() => void)[] = [];
    let asked = 0;
    const t: Target = {
      root: "/proj",
      ready: Promise.resolve(),
      supports: () => true,
      sync: () => {},
      request: () => {
        const n = asked++;
        return new Promise((resolve) =>
          queue.push(() =>
            resolve([
              // The nth answer names its own symbol, so what got published is
              // unambiguous.
              { name: `answer${n}`, kind: 12, range: range(n, 0, n, 5), selectionRange: range(n, 0, n, 5) },
            ]),
          ),
        );
      },
    };
    // Awaits the request being *made*: `refreshDocumentSymbols` yields on
    // `target.ready` first, so nothing is queued in the turn a test calls it.
    const release = async (i: number) => {
      for (let tries = 0; !queue[i] && tries < 20; tries++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      queue[i]();
    };
    return { t, release, asked: () => asked };
  }

  it("publishes the answer", async () => {
    targets = [
      target({
        provides: ["documentSymbolProvider"],
        res: [{ name: "Thing", kind: 5, range: range(0, 0, 4, 1), selectionRange: range(0, 6, 0, 11) }],
      }),
    ];
    await expect(refreshDocumentSymbols(PATH)).resolves.toBe(true);
    expect(symbolsFor(PATH).map((n) => n.name)).toEqual(["Thing"]);
  });

  it("drops a reply a newer request has superseded", async () => {
    // The bug this exists for: a tab swap, a client lifecycle change and the
    // typing debounce can all be in flight at once. If the first request's
    // reply lands last, every line number in the outline is from before the
    // last edit, so the panel looks right and every row jumps to the wrong line.
    const { t, release } = slowTarget();
    targets = [t];
    const first = refreshDocumentSymbols(PATH);
    const second = refreshDocumentSymbols(PATH);
    await release(1); // the newer request answers first
    expect(await second).toBe(true);
    await release(0); // and the older one lands after it
    expect(await first).toBe(false);
    expect(symbolsFor(PATH).map((n) => n.name)).toEqual(["answer1"]);
  });

  it("still publishes a slow reply when nothing newer was asked", async () => {
    // The guard must not turn "slow" into "dropped": a cold server answering
    // the only outstanding request is exactly the case the outline waits for.
    const { t, release } = slowTarget();
    targets = [t];
    const only = refreshDocumentSymbols(PATH);
    await release(0);
    expect(await only).toBe(true);
    expect(symbolsFor(PATH).map((n) => n.name)).toEqual(["answer0"]);
  });

  it("keeps requests for different files independent", async () => {
    // A swap asks about B while A is still answering. A's reply is still A's
    // answer, and the store is keyed by path, so it is kept.
    const { t, release } = slowTarget();
    targets = [t];
    const a = refreshDocumentSymbols("/proj/src/a.ts");
    const b = refreshDocumentSymbols("/proj/src/b.ts");
    await release(1);
    await release(0);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(symbolsSupported("/proj/src/a.ts")).toBe(true);
    expect(symbolsSupported("/proj/src/b.ts")).toBe(true);
  });

  it("does not publish for a file closed while the server was answering", async () => {
    // Otherwise it puts back an entry the tab close already dropped, and
    // nothing would ever drop it again.
    const { t, release } = slowTarget();
    targets = [t];
    let open = true;
    const pending = refreshDocumentSymbols(PATH, () => open);
    open = false;
    await release(0);
    expect(await pending).toBe(false);
    expect(symbolsSupported(PATH)).toBe(false);
  });

  it("publishes the no-provider answer, which is what hides the Outline tab", async () => {
    targets = [target({ provides: [] })];
    await refreshDocumentSymbols(PATH);
    expect(symbolsSupported(PATH)).toBe(false);
  });
});

describe("requestWorkspaceSymbols", () => {
  const hit = (name: string, uri: string, line: number) => ({
    name,
    kind: 12,
    location: { uri, range: range(line, 0, line, 5) },
  });

  it("sends nothing for an empty query", async () => {
    const t = target({ provides: ["workspaceSymbolProvider"] });
    targets = [t];
    await expect(requestWorkspaceSymbols("")).resolves.toEqual([]);
    expect(t.asked).toHaveLength(0);
  });

  it("asks every live server, because each one only sees its own root", async () => {
    // A monorepo has a session per package; `workspace/symbol` is scoped to the
    // root its session was started at, so asking one of them sees one package.
    targets = [
      target({ root: "/proj/a", provides: ["workspaceSymbolProvider"], res: [hit("fromA", "file:///proj/a/x.ts", 1)] }),
      target({ root: "/proj/b", provides: ["workspaceSymbolProvider"], res: [hit("fromB", "file:///proj/b/y.ts", 2)] }),
    ];
    const hits = await requestWorkspaceSymbols("from");
    expect(hits.map((h) => h.name).sort()).toEqual(["fromA", "fromB"]);
  });

  it("skips a server with no provider without asking it", async () => {
    const mute = target({ root: "/proj/a", provides: [] });
    targets = [
      mute,
      target({ root: "/proj/b", provides: ["workspaceSymbolProvider"], res: [hit("f", "file:///proj/b/y.ts", 0)] }),
    ];
    expect((await requestWorkspaceSymbols("f")).map((h) => h.name)).toEqual(["f"]);
    expect(mute.asked).toHaveLength(0);
  });

  it("lets one dead server not blank out a live one's results", async () => {
    targets = [
      target({ root: "/proj/a", provides: ["workspaceSymbolProvider"], fail: "timed out" }),
      target({ root: "/proj/b", provides: ["workspaceSymbolProvider"], res: [hit("alive", "file:///proj/b/y.ts", 0)] }),
    ];
    expect((await requestWorkspaceSymbols("a")).map((h) => h.name)).toEqual(["alive"]);
  });

  it("de-duplicates a file two nested sessions can both see", async () => {
    // A repo-root session and a package session overlap on every file in the
    // package, so the same symbol comes back twice - and the two servers need
    // not have spelled its uri the same way, which is why the key is the path.
    const same = hit("shared", "file:///proj/a/x.ts", 3);
    targets = [
      target({ root: "/proj", provides: ["workspaceSymbolProvider"], res: [same] }),
      target({
        root: "/proj/a",
        provides: ["workspaceSymbolProvider"],
        res: [{ ...same, location: { ...same.location, uri: "file:///proj/a/x.ts" } }],
      }),
    ];
    expect(await requestWorkspaceSymbols("shared")).toHaveLength(1);
  });
});
