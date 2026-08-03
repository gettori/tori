import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import { symbolClientCapabilities } from "../../utils/symbols";
import { semanticTokensClientCapabilities } from "../../utils/semanticTokens";

// Two claims, and the feature is invisible unless both hold:
//
//   1. the semantic-tokens capability survives the library's own merge, so the
//      `initialize` that actually goes out asks for them - a conformant server
//      offers no provider for something the client never requested;
//   2. the request layer reads the legend off *that* session before decoding,
//      and answers "no colours" rather than throwing when there is none.
//
// The first is checked against the real `LSPClient`, because the merge is the
// library's code and a hand-rolled copy of it would pass while the real one
// did not.

type Target = {
  root: string;
  ready: Promise<void>;
  supports: (cap: string) => boolean;
  capability: (name: string) => unknown;
  sync: () => void;
  request: (method: string, params: unknown) => Promise<unknown>;
};

let targets: Target[] = [];

vi.mock("./lspClient", () => ({
  lspTargetFor: (path: string) => targets.find((t) => path.startsWith(t.root)) ?? null,
  lspTargets: () => targets,
}));

const { requestSemanticTokens, refreshSemanticTokens } = await import("./lspSemanticTokens");
type SemanticDeps = import("./lspSemanticTokens").SemanticDeps;
type SemanticToken = import("../../utils/semanticTokens").SemanticToken;

const LEGEND = {
  tokenTypes: ["function", "parameter", "property"],
  tokenModifiers: ["declaration", "deprecated"],
};

/** A target that answers `res` to everything, recording what it was asked. */
function target(opts: {
  root?: string;
  legend?: unknown;
  res?: unknown;
  fail?: string;
  hold?: boolean;
}): Target & { asked: unknown[]; synced: number; release: () => Promise<void> } {
  let release = () => {};
  const asked: unknown[] = [];
  const t = {
    root: opts.root ?? "/proj",
    ready: Promise.resolve(),
    supports: (cap: string) => cap === "semanticTokensProvider" && !!opts.legend,
    capability: (name: string) =>
      name === "semanticTokensProvider" && opts.legend ? { legend: opts.legend, full: true } : undefined,
    sync: () => {
      t.synced += 1;
    },
    request: (method: string, params: unknown) => {
      asked.push({ method, params });
      if (opts.fail) return Promise.reject(new Error(opts.fail));
      if (!opts.hold) return Promise.resolve(opts.res ?? null);
      return new Promise((resolve) => (release = () => resolve(opts.res ?? null)));
    },
    asked,
    synced: 0,
    // Bounded rather than immediate: `requestSemanticTokens` yields on
    // `target.ready` before it calls `request`, so in the turn a test says
    // "release" there is often nothing held yet, and `release` is still the
    // no-op it starts as.
    release: async () => {
      for (let i = 0; i < 20 && asked.length === 0; i += 1) await Promise.resolve();
      release();
    },
  };
  return t;
}

beforeEach(() => {
  targets = [];
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
      extensions: [
        ...languageServerExtensions(),
        symbolClientCapabilities,
        semanticTokensClientCapabilities,
      ],
    }).connect(transport);
    const init = JSON.parse(sent[0]);
    // Answered so the client's own request timer clears and `initializing`
    // resolves; an unanswered initialize rejects three seconds later, into
    // nothing.
    for (const h of handlers) {
      h(JSON.stringify({ jsonrpc: "2.0", id: init.id, result: { capabilities: {} } }));
    }
    return { init, client };
  }

  it("asks for semantic tokens", async () => {
    const { init, client } = connectAndReadInit();
    const semantic = init.params.capabilities.textDocument.semanticTokens;
    expect(semantic.requests.full).toBe(true);
    expect(semantic.formats).toEqual(["relative"]);
    expect(semantic.tokenTypes).toContain("parameter");
    await client.initializing;
  });

  it("keeps what the library and the symbol block already advertised", async () => {
    // `mergeCapabilities` is a deep merge, but a shallow one would drop the
    // whole `textDocument` block the moment a second Sway extension added a key
    // to it - and this is the second one.
    const { init, client } = connectAndReadInit();
    const caps = init.params.capabilities;
    expect(caps.textDocument.hover).toBeTruthy();
    expect(caps.textDocument.rename).toBeTruthy();
    expect(caps.textDocument.documentSymbol).toBeTruthy();
    expect(caps.workspace.symbol).toBeTruthy();
    await client.initializing;
  });

  it("invites the refresh request and nothing else", async () => {
    // `refreshSupport` is the single exception to the rule: it is answered in
    // `lspClient.ts`'s transport, so asking for it is honest. The other two
    // would draw requests this client replies to with -32601, and their absence
    // is also what keeps servers doing their own file watching.
    const { init, client } = connectAndReadInit();
    const workspace = init.params.capabilities.workspace;
    expect(workspace.semanticTokens.refreshSupport).toBe(true);
    expect(workspace.configuration).toBeUndefined();
    expect(workspace.didChangeWatchedFiles).toBeUndefined();
    await client.initializing;
  });
});

describe("requestSemanticTokens", () => {
  const PATH = "/proj/src/a.ts";
  // `greet` at 0:9, a parameter at 0:15, the same parameter again at 1:9.
  const DATA = [0, 9, 5, 0, 1, 0, 6, 4, 1, 1, 1, 9, 4, 1, 0];

  it("decodes a server's answer against that server's legend", async () => {
    targets = [target({ legend: LEGEND, res: { data: DATA } })];
    expect(await requestSemanticTokens(PATH)).toEqual([
      { line: 0, char: 9, length: 5, type: "function", modifiers: ["declaration"] },
      { line: 0, char: 15, length: 4, type: "parameter", modifiers: ["declaration"] },
      { line: 1, char: 9, length: 4, type: "parameter", modifiers: [] },
    ]);
  });

  it("asks the server that answers for the file", async () => {
    const t = target({ legend: LEGEND, res: { data: [] } });
    targets = [t];
    await requestSemanticTokens(PATH);
    expect(t.asked).toEqual([
      {
        method: "textDocument/semanticTokens/full",
        params: { textDocument: { uri: "file:///proj/src/a.ts" } },
      },
    ]);
  });

  it("flushes the document before asking", async () => {
    // The library's own sync is debounced by 500 ms, and every token in the
    // answer is a position: asked inside that window, the whole file is coloured
    // a few characters to the left of the words it describes.
    const t = target({ legend: LEGEND, res: { data: DATA } });
    targets = [t];
    await requestSemanticTokens(PATH);
    expect(t.synced).toBe(1);
  });

  it("is null when no server claims the file", async () => {
    targets = [];
    expect(await requestSemanticTokens(PATH)).toBeNull();
  });

  it("is null when the server advertises no legend", async () => {
    // A provider without a legend is a stream of integers with no meaning, and
    // guessing at one would colour the file confidently and wrongly. The same
    // answer as having no provider at all: keep the grammar's colours.
    const t = target({ res: { data: DATA } });
    targets = [t];
    expect(await requestSemanticTokens(PATH)).toBeNull();
    expect(t.asked).toEqual([]);
  });

  it("is null when the request fails", async () => {
    targets = [target({ legend: LEGEND, fail: "timed out" })];
    expect(await requestSemanticTokens(PATH)).toBeNull();
  });

  it("is empty, not null, when the server has nothing to say about the file", async () => {
    // A server may answer null for a file it does not tokenise. Distinct from a
    // refusal: it is an answer, so the caller clears rather than leaving a
    // previous file's colours in place.
    targets = [target({ legend: LEGEND, res: null })];
    expect(await requestSemanticTokens(PATH)).toEqual([]);
  });

  it("waits for initialize rather than refusing a file opened as the server came up", async () => {
    // The legend only exists once initialize has been answered, so refusing
    // early would make colour depend on how fast the server started.
    let ready!: () => void;
    const t = target({ legend: LEGEND, res: { data: DATA } });
    t.ready = new Promise<void>((r) => (ready = r));
    targets = [t];
    const pending = requestSemanticTokens(PATH);
    expect(t.asked).toEqual([]);
    ready();
    expect(await pending).toHaveLength(3);
  });
});

describe("refreshSemanticTokens", () => {
  const PATH = "/proj/src/a.ts";

  /** A stand-in editor. `doc` is swapped by a test to move the document while
   *  the server is answering; `painted` is what the buffer already holds. */
  function editor(opts: { painted?: number; gone?: boolean } = {}) {
    const state = {
      doc: { id: 1 } as unknown,
      painted: opts.painted ?? 0,
      gone: opts.gone ?? false,
      paints: [] as SemanticToken[][],
      agains: 0,
    };
    const deps: SemanticDeps = {
      current: () => (state.gone ? null : { id: state.doc, painted: state.painted }),
      paint: (_path, tokens) => void state.paints.push(tokens),
      again: () => void (state.agains += 1),
    };
    return { deps, state };
  }

  it("paints the tokens it was given", async () => {
    targets = [target({ legend: LEGEND, res: { data: [0, 0, 3, 1, 0] } })];
    const { deps, state } = editor();
    expect(await refreshSemanticTokens(deps, PATH)).toBe("painted");
    expect(state.paints).toEqual([
      [{ line: 0, char: 0, length: 3, type: "parameter", modifiers: [] }],
    ]);
  });

  it("clears a file that has lost its server", async () => {
    // An empty paint, not silence: otherwise the file goes on wearing a dead
    // server's colours until it is closed.
    targets = [];
    const { deps, state } = editor({ painted: 12 });
    expect(await refreshSemanticTokens(deps, PATH)).toBe("painted");
    expect(state.paints).toEqual([[]]);
  });

  it("does nothing when there is nothing to paint and nothing painted", async () => {
    // Every swap to a plain text file would otherwise dispatch an empty effect
    // into a buffer that will never have colours.
    targets = [];
    const { deps, state } = editor({ painted: 0 });
    expect(await refreshSemanticTokens(deps, PATH)).toBe("unchanged");
    expect(state.paints).toEqual([]);
  });

  it("drops an answer for a document that moved while it was in flight", async () => {
    // Typed into during the round trip. Every token in the reply is a position
    // in a document that no longer exists, so applying it would paint the whole
    // file a few characters to one side of the words it describes.
    const held = target({ legend: LEGEND, res: { data: [0, 0, 3, 1, 0] }, hold: true });
    targets = [held];
    const { deps, state } = editor();
    const pending = refreshSemanticTokens(deps, PATH);
    state.doc = { id: 2 };
    await held.release();
    expect(await pending).toBe("moved");
    expect(state.paints).toEqual([]);
  });

  it("asks again after dropping one, so the colours converge", async () => {
    // Nothing else would: the typing debounce already fired, and this is the
    // only path back to a correct answer.
    const held = target({ legend: LEGEND, res: { data: [0, 0, 3, 1, 0] }, hold: true });
    targets = [held];
    const { deps, state } = editor();
    const pending = refreshSemanticTokens(deps, PATH);
    state.doc = { id: 2 };
    await held.release();
    await pending;
    expect(state.agains).toBe(1);
  });

  it("does not confuse identical content for the same document", async () => {
    // `Text` is immutable, so a new instance is a new document even when it
    // spells the same thing - which is what catches a same-length edit that
    // comparing text would wave through.
    const held = target({ legend: LEGEND, res: { data: [0, 0, 3, 1, 0] }, hold: true });
    targets = [held];
    const { deps, state } = editor();
    const pending = refreshSemanticTokens(deps, PATH);
    state.doc = { id: 1 }; // same shape, new instance
    await held.release();
    expect(await pending).toBe("moved");
  });

  it("writes nothing when the buffer went away mid-request", async () => {
    const held = target({ legend: LEGEND, res: { data: [0, 0, 3, 1, 0] }, hold: true });
    targets = [held];
    const { deps, state } = editor();
    const pending = refreshSemanticTokens(deps, PATH);
    state.gone = true;
    await held.release();
    expect(await pending).toBe("gone");
    expect(state.paints).toEqual([]);
    // Not `again`: there is no buffer to converge on.
    expect(state.agains).toBe(0);
  });

  it("never asks about a file that is not there to paint", async () => {
    const t = target({ legend: LEGEND, res: { data: [] } });
    targets = [t];
    const { deps } = editor({ gone: true });
    expect(await refreshSemanticTokens(deps, PATH)).toBe("gone");
    expect(t.asked).toEqual([]);
  });

  it("drops a reply that a newer ask has already superseded", async () => {
    // Four things re-ask: a tab swap, a client coming up, the typing debounce,
    // and the server's own refresh. A busy server can answer them out of order,
    // and an older reply landing last is every colour in the file placed
    // against a document that has since been edited.
    const slow = target({ legend: LEGEND, res: { data: [0, 0, 3, 1, 0] }, hold: true });
    targets = [slow];
    const { deps, state } = editor();
    const first = refreshSemanticTokens(deps, PATH);
    // Same path, asked again before the first came back.
    targets = [target({ legend: LEGEND, res: { data: [0, 0, 4, 2, 0] } })];
    expect(await refreshSemanticTokens(deps, PATH)).toBe("painted");
    await slow.release();
    expect(await first).toBe("superseded");
    expect(state.paints).toHaveLength(1);
    expect(state.paints[0][0].length).toBe(4);
  });

  it("keeps a reply for a file that is not the one just asked about", async () => {
    // The guard is per path, so a swap away and back does not throw away the
    // answer for the file left behind: it is still that file's answer.
    targets = [target({ legend: LEGEND, root: "/proj", res: { data: [0, 0, 3, 1, 0] } })];
    const { deps, state } = editor();
    await refreshSemanticTokens(deps, "/proj/a.ts");
    await refreshSemanticTokens(deps, "/proj/b.ts");
    expect(state.paints).toHaveLength(2);
  });
});
