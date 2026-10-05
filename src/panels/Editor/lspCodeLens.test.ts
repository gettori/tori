import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
// Static, and above the dynamic import below rather than beside it: an
// `import type` is erased, so its position is about reading order only, and a
// type import written under a top-level `await import` reads as if it were
// sequenced by it.
import type { CodeLensDeps, CodeLensItem } from "./lspCodeLens";

type Caps = { codeLensProvider?: { resolveProvider?: boolean } };

type Target = {
  root: string;
  ready: Promise<void>;
  supports: (cap: string) => boolean;
  capability: (name: string) => unknown;
  sync: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

let target: Target | null = null;
// Every call in order, so "did it flush before it asked" is a question about a
// sequence rather than about two counters.
let calls: string[] = [];

vi.mock("./lspClient", () => ({ lspTargetFor: () => target }));

const { normalizeCodeLenses, requestCodeLenses, refreshCodeLenses, MAX_CODE_LENSES } =
  await import("./lspCodeLens");

/** One lens as a server sends it. `data` is the private state the resolve round
 *  trip exists to carry back. */
function lens(line: number, title?: string) {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    ...(title === undefined ? {} : { command: { title, command: "noop" } }),
    data: { server: "private", line },
  };
}

function fakeTarget(over: Partial<Target> = {}, caps: Caps = { codeLensProvider: {} }): Target {
  return {
    root: "/repo",
    ready: Promise.resolve(),
    supports: (cap) => cap in caps,
    capability: (name) => (caps as Record<string, unknown>)[name],
    sync: () => calls.push("sync"),
    request: (method) => {
      calls.push(`request ${method}`);
      return Promise.resolve([lens(4, "3 references")]);
    },
    ...over,
  };
}

/** A buffer that never moves and is always the one on screen. */
const doc = {};
function deps(painted: (CodeLensItem[] | null)[]): CodeLensDeps {
  return {
    current: () => ({ id: doc }),
    paint: (_path, lenses) => void painted.push(lenses),
  };
}

beforeEach(() => {
  calls = [];
  target = fakeTarget();
});

describe("reading what the server sent", () => {
  it("counts lines the way the editor does", () => {
    // LSP counts from 0 and CodeMirror from 1, and an off-by-one here draws
    // every count above the wrong function rather than failing.
    expect(normalizeCodeLenses([lens(0, "a"), lens(41, "b")]).map((l) => l.line)).toEqual([1, 42]);
  });

  it("keeps the server's own lens verbatim, because the resolve hands it back", () => {
    const raw = lens(4);
    expect(normalizeCodeLenses([raw])[0].raw).toBe(raw);
  });

  it("reads a lens that already carries its title, and marks one that does not", () => {
    expect(normalizeCodeLenses([lens(0, "3 references"), lens(1)]).map((l) => l.title)).toEqual([
      "3 references",
      null,
    ]);
  });

  it("drops an unreadable entry rather than throwing", () => {
    expect(normalizeCodeLenses(null)).toEqual([]);
    expect(normalizeCodeLenses([{}, { range: {} }, lens(0, "ok")])).toHaveLength(1);
  });

  it("bounds a file that would be thousands of resolves", () => {
    // The cap is on the lenses, not on the resolves, because the resolves are
    // one per lens: without it a generated file issues a request per exported
    // symbol, all at once, for labels nobody scrolled to.
    const many = Array.from({ length: MAX_CODE_LENSES + 50 }, (_, i) => lens(i, "x"));
    expect(normalizeCodeLenses(many)).toHaveLength(MAX_CODE_LENSES);
  });
});

describe("asking for a file's lenses", () => {
  it("flushes the document before asking, so the lines mean what was typed", async () => {
    await requestCodeLenses("/repo/a.ts");
    expect(calls).toEqual(["sync", "request textDocument/codeLens"]);
  });

  it("answers null for a server with no provider, and never asks", async () => {
    target = fakeTarget({}, {});
    expect(await requestCodeLenses("/repo/a.ts")).toBe(null);
    expect(calls).toEqual([]);
  });

  it("answers null when nothing claims the file at all", async () => {
    target = null;
    expect(await requestCodeLenses("/repo/a.txt")).toBe(null);
  });

  it("resolves an untitled lens by handing the server its own lens back", async () => {
    // The spec's round trip is "the lens you gave me", and a server hangs its
    // own `data` on it. A rebuilt lens resolves to nothing, with nothing on the
    // wire to say why.
    const untitled = lens(4);
    const sent: unknown[] = [];
    target = fakeTarget(
      {
        request: (method, params) => {
          calls.push(`request ${method}`);
          if (method === "textDocument/codeLens") return Promise.resolve([untitled]);
          sent.push(params);
          return Promise.resolve({ ...untitled, command: { title: "7 references", command: "noop" } });
        },
      },
      { codeLensProvider: { resolveProvider: true } },
    );

    expect((await requestCodeLenses("/repo/a.ts"))?.map((l) => l.title)).toEqual(["7 references"]);
    expect(sent).toEqual([untitled]);
  });

  it("does not resolve against a server that only places lenses", async () => {
    // `codeLensProvider: {}` says "I place lenses", not "I can resolve them",
    // and asking anyway draws a MethodNotFound per lens.
    target = fakeTarget({
      request: (method) => {
        calls.push(`request ${method}`);
        return Promise.resolve([lens(4)]);
      },
    });
    await requestCodeLenses("/repo/a.ts");
    expect(calls).toEqual(["sync", "request textDocument/codeLens"]);
  });

  it("drops a lens that is still untitled, rather than drawing a blank strip", async () => {
    // A block widget with no content is a line of vertical space the user
    // cannot delete and cannot explain.
    target = fakeTarget({
      request: (method) => {
        calls.push(`request ${method}`);
        return Promise.resolve([lens(4, "3 references"), lens(9)]);
      },
    });
    expect((await requestCodeLenses("/repo/a.ts"))?.map((l) => l.line)).toEqual([5]);
  });

  it("loses one lens to a failed resolve rather than the file's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    target = fakeTarget(
      {
        request: (method) => {
          if (method === "textDocument/codeLens") return Promise.resolve([lens(0), lens(4, "kept")]);
          return Promise.reject(new Error("boom"));
        },
      },
      { codeLensProvider: { resolveProvider: true } },
    );
    expect((await requestCodeLenses("/repo/a.ts"))?.map((l) => l.title)).toEqual(["kept"]);
    warn.mockRestore();
  });

  it("answers null rather than throwing when the request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    target = fakeTarget({ request: () => Promise.reject(new Error("boom")) });
    expect(await requestCodeLenses("/repo/a.ts")).toBe(null);
    warn.mockRestore();
  });
});

describe("painting an answer, or refusing to", () => {
  it("paints what the server said", async () => {
    const painted: (CodeLensItem[] | null)[] = [];
    expect(await refreshCodeLenses(deps(painted), "/repo/a.ts")).toBe("painted");
    expect(painted[0]?.map((l) => [l.line, l.title])).toEqual([[5, "3 references"]]);
  });

  it("clears a file whose server has gone rather than leaving a dead one's counts", async () => {
    // `null` from the request is "no answer to be had", and the honest drawing
    // of that is nothing at all - not the numbers from before the project
    // switch, which are about a program that is no longer loaded.
    target = fakeTarget({}, {});
    const painted: (CodeLensItem[] | null)[] = [];
    expect(await refreshCodeLenses(deps(painted), "/repo/a.ts")).toBe("painted");
    expect(painted[0]).toEqual([]);
  });

  it("discards a slower reply for the same file", async () => {
    // Two asks for one file, the first answering last. Painting it puts the
    // counts from before the edit back over the code after it, and every one of
    // them looks like a real number.
    const replies: ((value: unknown) => void)[] = [];
    target = fakeTarget({ request: () => new Promise((resolve) => replies.push(resolve)) });
    const painted: (CodeLensItem[] | null)[] = [];
    const d = deps(painted);

    const first = refreshCodeLenses(d, "/repo/a.ts");
    const second = refreshCodeLenses(d, "/repo/a.ts");
    for (let i = 0; i < 8; i++) await Promise.resolve();

    replies[1]([lens(0, "newer")]);
    replies[0]([lens(0, "older")]);

    expect(await second).toBe("painted");
    expect(await first).toBe("superseded");
    expect(painted.flat().map((l) => l?.title)).toEqual(["newer"]);
  });

  it("discards a reply for a tab that was left while the server answered", async () => {
    // The token above cannot see this one: it is keyed on the path, and this
    // reply is about a different path than the one now on screen. Without the
    // *second* look at `current`, the previous file's lenses land in the file
    // the user switched to.
    //
    // The tab is closed from inside the request, deliberately: a `current` that
    // answers null from the start is refused before the request is even made,
    // so it tests the cheap guard and says nothing about this one.
    const painted: (CodeLensItem[] | null)[] = [];
    let open = true;
    target = fakeTarget({
      request: () => {
        open = false;
        return Promise.resolve([lens(0, "from the tab you left")]);
      },
    });

    const outcome = await refreshCodeLenses(
      { current: () => (open ? { id: doc } : null), paint: (_p, l) => void painted.push(l) },
      "/repo/a.ts",
    );
    expect(outcome).toBe("gone");
    expect(painted).toEqual([]);
  });

  it("refuses before asking when there is no buffer to paint into at all", async () => {
    const painted: (CodeLensItem[] | null)[] = [];
    const outcome = await refreshCodeLenses(
      { current: () => null, paint: (_p, l) => void painted.push(l) },
      "/repo/a.ts",
    );
    expect(outcome).toBe("gone");
    expect(calls).toEqual([]);
  });

  it("drops a reply whose document moved under it", async () => {
    // Every line in the answer names a line of a document that no longer
    // exists. Nothing re-asks from here: the edit that moved it is itself what
    // schedules the next refresh, so re-asking would only double it.
    const painted: (CodeLensItem[] | null)[] = [];
    let id = {};
    const outcome = await refreshCodeLenses(
      {
        current: () => ({ id: (id = {}) }),
        paint: (_p, l) => void painted.push(l),
      },
      "/repo/a.ts",
    );
    expect(id).toBeTruthy();
    expect(outcome).toBe("moved");
    expect(painted).toEqual([]);
  });
});
