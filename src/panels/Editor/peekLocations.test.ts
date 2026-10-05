import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

// What the fake backend has on disk, and what it was asked for.
let disk: Record<string, string> = {};
let diskReads: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "fs_read_file") {
      const path = args?.path as string;
      diskReads.push(path);
      return path in disk ? Promise.resolve(disk[path]) : Promise.reject(new Error("ENOENT"));
    }
    return Promise.resolve();
  },
}));

type Target = {
  root: string;
  ready: Promise<void>;
  supports: (cap: string) => boolean;
  sync: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

let target: Target | null = null;
// Every call in order, so "did it sync before it asked" is a question about a
// sequence rather than about two counters.
let calls: string[] = [];

vi.mock("./lspClient", () => ({
  lspTargetFor: () => target,
}));

const { normalizeLocations, peekAt, peekSourceText } = await import("./peekLocations");
const { setBufferAccess } = await import("./liveBuffers");

/** Let the `await target.ready` inside `peekAt` run, so the request has
 *  actually been made and its resolver is registered. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function fakeTarget(over: Partial<Target> = {}): Target {
  return {
    root: "/p",
    ready: Promise.resolve(),
    supports: () => true,
    sync: () => calls.push("sync"),
    request: (method) => {
      calls.push(`request ${method}`);
      return Promise.resolve([{ uri: "file:///p/a.ts", range: { start: { line: 4 }, end: { line: 6 } } }]);
    },
    ...over,
  };
}

beforeEach(() => {
  disk = {};
  diskReads = [];
  calls = [];
  target = fakeTarget();
});

describe("reading a reply", () => {
  it("takes a Location", () => {
    expect(normalizeLocations([{ uri: "file:///p/a.ts", range: { start: { line: 2 }, end: { line: 3 } } }])).toEqual([
      { path: "/p/a.ts", line: 2, endLine: 3 },
    ]);
  });

  it("takes a bare Location, which is a legal answer to a definition", () => {
    expect(normalizeLocations({ uri: "file:///p/a.ts", range: { start: { line: 0 }, end: { line: 0 } } })).toEqual([
      { path: "/p/a.ts", line: 0, endLine: 0 },
    ]);
  });

  it("takes a LocationLink, and reads its target rather than its origin", () => {
    // `originSelectionRange` is the word under the caret, in the file being
    // read. A peek that rendered that would show you the line you are on.
    expect(
      normalizeLocations([
        {
          targetUri: "file:///p/b.ts",
          originSelectionRange: { start: { line: 99 }, end: { line: 99 } },
          targetRange: { start: { line: 7 }, end: { line: 9 } },
        },
      ]),
    ).toEqual([{ path: "/p/b.ts", line: 7, endLine: 9 }]);
  });

  it("reads null and an empty reply as no results rather than as a failure", () => {
    expect(normalizeLocations(null)).toEqual([]);
    expect(normalizeLocations([])).toEqual([]);
  });

  it("drops an unreadable entry and keeps the rest", () => {
    // Nineteen readable locations out of twenty is a reason to show nineteen.
    const out = normalizeLocations([
      { uri: "file:///p/a.ts", range: { start: { line: 1 }, end: { line: 1 } } },
      { uri: "not a uri", range: { start: { line: 1 } } },
      { range: { start: { line: 1 } } },
      { uri: "file:///p/c.ts" },
      { uri: "file:///p/d.ts", range: { start: { line: 3 } } },
    ]);
    expect(out).toEqual([
      { path: "/p/a.ts", line: 1, endLine: 1 },
      { path: "/p/d.ts", line: 3, endLine: 3 },
    ]);
  });
});

describe("where the peeked text comes from", () => {
  it("shows a dirty background buffer's unsaved text, not the file on disk", () => {
    // The rule the workspace bridge uses. Reading the disk copy would show the
    // user a version of their own file they cannot see anywhere else.
    disk = { "/p/a.ts": "what was saved" };
    const release = setBufferAccess({
      textOf: (p) => (p === "/p/a.ts" ? "what they typed" : null),
      isDirty: () => true,
      adopt: () => {},
      patch: () => "absent",
    });
    return peekSourceText("/p/a.ts").then((text) => {
      expect(text).toBe("what they typed");
      // And the disk was not read at all: the buffer is the answer, not a
      // preference applied after both were fetched.
      expect(diskReads).toEqual([]);
      release();
    });
  });

  it("falls back to disk for a file no buffer holds", async () => {
    disk = { "/p/b.ts": "on disk" };
    expect(await peekSourceText("/p/b.ts")).toBe("on disk");
  });

  it("answers null for a file that cannot be read, rather than throwing", async () => {
    expect(await peekSourceText("/p/gone.ts")).toBe(null);
  });
});

describe("asking the server", () => {
  it("flushes the document before asking, so the positions are about what was typed", async () => {
    // The library's sync is debounced by 500 ms. Without this, typing and
    // peeking immediately is answered against text the server has not seen.
    let published: unknown;
    await peekAt("definition", "/p/a.ts", { line: 1, character: 2 }, (l) => {
      published = l;
    });
    expect(calls).toEqual(["sync", "request textDocument/definition"]);
    expect(published).toEqual([{ path: "/p/a.ts", line: 4, endLine: 6 }]);
  });

  it("asks for references with the declaration included", async () => {
    let params: unknown;
    target = fakeTarget({
      request: (method, p) => {
        calls.push(`request ${method}`);
        params = p;
        return Promise.resolve([]);
      },
    });
    await peekAt("references", "/p/a.ts", { line: 1, character: 2 }, () => {});
    expect(params).toMatchObject({ context: { includeDeclaration: true } });
  });

  it("publishes null when nothing claims the file", async () => {
    target = null;
    let published: unknown = "untouched";
    await peekAt("definition", "/p/a.ts", { line: 0, character: 0 }, (l) => {
      published = l;
    });
    expect(published).toBe(null);
  });

  it("publishes null when the server advertises no provider", async () => {
    target = fakeTarget({ supports: () => false });
    let published: unknown = "untouched";
    await peekAt("definition", "/p/a.ts", { line: 0, character: 0 }, (l) => {
      published = l;
    });
    expect(published).toBe(null);
    // And it never asked, which is what keeps a MethodNotFound off the wire.
    expect(calls).toEqual([]);
  });

  it("publishes null rather than throwing when the request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    target = fakeTarget({ request: () => Promise.reject(new Error("boom")) });
    let published: unknown = "untouched";
    await peekAt("definition", "/p/a.ts", { line: 0, character: 0 }, (l) => {
      published = l;
    });
    expect(published).toBe(null);
    warn.mockRestore();
  });

  it("discards a slower reply for an earlier position", async () => {
    // The guard the whole module exists around. A reply for the line the caret
    // *used* to be on, landing last, is a peek showing the right source for the
    // wrong symbol - which looks exactly like a working feature.
    const replies = new Map<number, (value: unknown) => void>();
    target = fakeTarget({
      request: (_m, params) =>
        new Promise((resolve) => {
          replies.set((params as { position: { line: number } }).position.line, resolve);
        }),
    });

    const published: unknown[] = [];
    const first = peekAt("definition", "/p/a.ts", { line: 1, character: 0 }, (l) => {
      published.push(l);
    });
    const second = peekAt("definition", "/p/a.ts", { line: 9, character: 0 }, (l) => {
      published.push(l);
    });
    await settle();

    // The newer question answers first, then the older one arrives late.
    replies.get(9)!([{ uri: "file:///p/new.ts", range: { start: { line: 0 }, end: { line: 0 } } }]);
    replies.get(1)!([{ uri: "file:///p/old.ts", range: { start: { line: 0 }, end: { line: 0 } } }]);

    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(published).toEqual([[{ path: "/p/new.ts", line: 0, endLine: 0 }]]);
  });

  it("treats the same question asked twice as one, so a repeat cannot overtake itself", async () => {
    // Keyed on what was asked rather than on the file: peeking the same symbol
    // twice is one question, and the second ask supersedes the first.
    const replies: ((value: unknown) => void)[] = [];
    target = fakeTarget({ request: () => new Promise((resolve) => replies.push(resolve)) });

    const published: unknown[] = [];
    const first = peekAt("definition", "/p/a.ts", { line: 3, character: 1 }, (l) => {
      published.push(l);
    });
    const second = peekAt("definition", "/p/a.ts", { line: 3, character: 1 }, (l) => {
      published.push(l);
    });
    await settle();
    replies[0]([]);
    replies[1]([]);

    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(published).toHaveLength(1);
  });
});
