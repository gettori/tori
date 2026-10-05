// Tori's completion source, against a real `LSPClient` and a real
// `EditorView`.
//
// The reason this is not a unit test of a pure function: what it replaces is
// the library's own source, and the risk in replacing it is not in the parts
// that are new but in the parts that were copied. So the client is built from
// `clientExtensions()` - the very list the app hands every session - and every
// assertion is made through the plugin the library installs. Only the transport
// is fake, and it answers the way a server does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { languageServerExtensions, LSPClient, type Transport } from "@codemirror/lsp-client";
import {
  CompletionContext,
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve(null),
  convertFileSrc: (p: string) => p,
  Channel: class {
    onmessage: unknown = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { clientExtensions } = await import("./lspClient");
const { RESOLVE_TIMEOUT_MS, toriCompletionSource, offsetOf, lspToSnippet, prefixRegexp } =
  await import("./lspCompletion");

const URI = "file:///proj/a.ts";

// ------------------------------------------- the fake server

type Reply = { id: number; method: string; params: Record<string, unknown> };

/** What `initialize` answers with. */
let capabilities: Record<string, unknown>;
/** What `textDocument/completion` answers with. */
let completionReply: unknown;
/** What `completionItem/resolve` answers with, given the item it was sent. */
let resolveWith: (item: Record<string, unknown>) => unknown;
/** When set, `completionItem/resolve` answers with this JSON-RPC error. */
let resolveError: { code: number; message: string } | null;
/** With this on, resolve replies are held until a test releases them. */
let holdResolve = false;
let held: (() => void)[] = [];
/** Every request the client sent, in order. */
let sent: Reply[] = [];
/** Every frame the client sent, requests and notifications alike, in order.
 *  Ordering between a `didChange` and a request is the whole point of a sync,
 *  and a request-only log cannot see it. */
let wire: { method: string; params: Record<string, unknown> }[] = [];

function transport(): Transport {
  let receive: ((msg: string) => void) | null = null;
  return {
    send: (message) => {
      const msg = JSON.parse(message) as { id?: number; method?: string; params?: Record<string, unknown> };
      wire.push({ method: msg.method!, params: msg.params ?? {} });
      if (msg.id === undefined) return; // a notification wants no answer
      sent.push({ id: msg.id, method: msg.method!, params: msg.params ?? {} });
      const answer = () => {
        if (msg.method === "completionItem/resolve" && resolveError) {
          receive?.(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: resolveError }));
          return;
        }
        const result =
          msg.method === "initialize"
            ? { capabilities }
            : msg.method === "textDocument/completion"
              ? completionReply
              : msg.method === "completionItem/resolve"
                ? resolveWith(msg.params ?? {})
                : null;
        receive?.(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (holdResolve && msg.method === "completionItem/resolve") held.push(answer);
      else answer();
    },
    subscribe: (h) => (receive = h),
    unsubscribe: () => {},
  };
}

// ------------------------------------------- the editor

let views: EditorView[] = [];

async function setup(doc = "", extra: Extension = [], uri = URI) {
  const client = new LSPClient({ extensions: clientExtensions("typescript") }).connect(transport());
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [client.plugin(uri, "typescript"), extra] }),
    parent: document.body,
  });
  views.push(view);
  // The transport answers `initialize` synchronously, but the client stores the
  // capabilities in a `then`. Awaited here so no test reads them off a client
  // that has not finished handshaking - which is the state that makes "the
  // server offers no provider" indistinguishable from "it has not said yet".
  await client.initializing;
  return { client, view };
}

async function complete(view: EditorView, pos = view.state.doc.length): Promise<CompletionResult> {
  const result = await toriCompletionSource(new CompletionContext(view.state, pos, true, view));
  expect(result, "the source answered nothing").toBeTruthy();
  return result as CompletionResult;
}

/** Accept an option exactly the way `@codemirror/autocomplete` does. */
function accept(view: EditorView, result: CompletionResult, index = 0) {
  const option: Completion = result.options[index];
  const apply = option.apply;
  const to = result.to ?? result.from;
  if (typeof apply === "function") apply(view, option, result.from, to);
  else view.dispatch(insertCompletionText(view.state, apply ?? option.label, result.from, to));
}

/** Let the resolve round trip settle. The transport answers synchronously, so
 *  what is being waited on is microtasks, not the clock. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const asked = (method: string) => sent.filter((s) => s.method === method);

beforeEach(() => {
  capabilities = {
    // Without this the client's `sync()` is a no-op, which would make the
    // ordering assertions below pass for the wrong reason.
    textDocumentSync: 1,
    completionProvider: { resolveProvider: true, triggerCharacters: ["."] },
  };
  completionReply = { items: [] };
  resolveWith = () => null;
  resolveError = null;
  holdResolve = false;
  held = [];
  sent = [];
  wire = [];
});

afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
  vi.restoreAllMocks();
});

// ------------------------------------------- the list the client is built from

describe("the client's extension list", () => {
  it("installs exactly one completion source, so no option can appear twice", async () => {
    // The failure this pins is not a crash: spreading `languageServerExtensions()`
    // *and* adding Tori's source leaves both registered, both asking the same
    // server the same question, and every option in the popup listed twice.
    const { view } = await setup("const x = 1\n");
    const sources = view.state.languageDataAt<CompletionSource>("autocomplete", 0);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toBe(toriCompletionSource);
  });

  it("binds F12 and ⇧F12, which `commands.ts` advertises as their `sub:` labels", async () => {
    // Not true until this phase: the client keeps a configured extension only
    // if it is an array or carries `.extension`, and `keymap.of(...)` is a bare
    // `FacetProvider`, so spread as a top-level entry out of
    // `languageServerExtensions()` the whole keymap was silently dropped. This
    // is the assertion that would have caught that, so it stays.
    const { view } = await setup("const x = 1\n");
    const bound = view.state.facet(keymap).flat();
    const by = (key: string) => bound.find((b) => b.key === key);

    for (const key of ["F12", "Shift-F12"]) {
      expect(by(key), key).toBeTruthy();
      expect(by(key)!.preventDefault, key).toBe(true);
    }
  });

  it("leaves ⇧⌥F and F2 alone, because Tori answers both better", async () => {
    // ⇧⌥F: `lsp-format` is on that chord already and tries the project's Biome
    // or Prettier before the server. Binding the library's would take it, and
    // because CodeMirror honours `preventDefault` even when a command declines,
    // it would take it in buffers with no server too - a stylesheet, a Markdown
    // file - where the project formatter is the only formatter there is.
    //
    // F2: `renameSymbol` skips every file the user has not already opened,
    // silently, which is the whole reason `lspRename.ts` exists. `CodeEditor`
    // binds F2 to Tori's rename at `Prec.highest`; this would be the fallback
    // underneath it, reachable exactly when Tori's declines.
    const { view } = await setup("const x = 1\n");
    const bound = view.state.facet(keymap).flat();

    expect(bound.find((b) => b.key === "Shift-Alt-f")).toBeUndefined();
    expect(bound.find((b) => b.key === "F2")).toBeUndefined();
  });

  it("declares resolveSupport for additionalTextEdits and nothing else", async () => {
    // `resolveSupport` is a licence, not a request. Naming `documentation` here
    // would let a server drop the docs from every item in the list, and Tori
    // resolves only on commit - so the popup would show nothing for anything
    // the user had not already accepted.
    await setup();
    const init = asked("initialize")[0];
    const completion = (init.params.capabilities as Record<string, never>).textDocument as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const item = completion.completion.completionItem;

    expect((item.resolveSupport as { properties: string[] }).properties).toEqual(["additionalTextEdits"]);
    expect(item.resolveSupport).not.toHaveProperty("documentation");
    // ...and the library's own completion block survived the merge, so docs are
    // still asked for up front rather than only on resolve.
    expect(item.documentationFormat).toEqual(["markdown", "plaintext"]);
    expect(item.snippetSupport).toBe(true);
  });

  it("changes nothing in the initialize payload except the completion block", async () => {
    // The verify this phase was written against, done literally: the baseline
    // is the list as it stood before, `languageServerExtensions()` spread with
    // Tori's capability blocks after it. Rewriting a list by hand is how a
    // capability quietly stops being advertised, and a server that was never
    // asked simply offers no provider - so the failure is a feature going
    // silent, not an error anyone sees.
    const { symbolClientCapabilities } = await import("../../utils/symbols");
    const { semanticTokensClientCapabilities } = await import("../../utils/semanticTokens");
    const { workspaceEditClientCapabilities } = await import("./serverEdits");
    const { codeActionClientCapabilities } = await import("./lspCodeActions");
    const { diagnosticContextCapture } = await import("./lspDiagnosticContext");
    const { configurationClientCapabilities } = await import("./lspConfiguration");
    const { callHierarchyClientCapabilities } = await import("../../utils/callHierarchy");
    const { codeLensClientCapabilities } = await import("./lspCodeLens");
    const { progressClientCapabilities } = await import("../../utils/lspProgress");

    const capabilitiesFor = (extensions: unknown[]) => {
      sent = [];
      new LSPClient({ extensions: extensions as never }).connect(transport());
      return asked("initialize")[0].params.capabilities as Record<string, Record<string, unknown>>;
    };

    const before = capabilitiesFor([
      diagnosticContextCapture("typescript"),
      ...languageServerExtensions(),
      symbolClientCapabilities,
      semanticTokensClientCapabilities,
      workspaceEditClientCapabilities,
      codeActionClientCapabilities,
      // Not part of the completion change, but a capability block all the
      // same: the baseline is "the old extension list plus every block Tori
      // declares", so that what this test measures stays the *completion*
      // delta rather than drifting into a record of everything since.
      configurationClientCapabilities,
      callHierarchyClientCapabilities,
      codeLensClientCapabilities,
      progressClientCapabilities,
    ]);
    const after = capabilitiesFor(clientExtensions("typescript"));

    const withoutCompletion = (caps: Record<string, Record<string, unknown>>) => {
      const { completion: _completion, ...textDocument } = caps.textDocument;
      return { ...caps, textDocument };
    };

    expect(withoutCompletion(after)).toEqual(withoutCompletion(before));
    // ...and inside the completion block, the only difference is the licence.
    const mine = (after.textDocument.completion as Record<string, Record<string, unknown>>).completionItem;
    const theirs = (before.textDocument.completion as Record<string, Record<string, unknown>>).completionItem;
    const { resolveSupport, ...rest } = mine;

    expect(rest).toEqual(theirs);
    expect(resolveSupport).toEqual({ properties: ["additionalTextEdits"] });
  });

  it("still advertises the blocks the earlier phases added", async () => {
    // The list was rewritten by hand; a dropped entry here is a feature that
    // goes quiet against a conformant server rather than failing loudly.
    await setup();
    const td = (asked("initialize")[0].params.capabilities as Record<string, Record<string, unknown>>).textDocument;
    const ws = (asked("initialize")[0].params.capabilities as Record<string, Record<string, unknown>>).workspace;

    expect(td.documentSymbol).toBeTruthy();
    expect(td.semanticTokens).toBeTruthy();
    expect(td.codeAction).toBeTruthy();
    expect(td.publishDiagnostics).toBeTruthy(); // serverDiagnostics(), still top-level
    // Wave 7 Phase 8. A conformant server offers no `callHierarchyProvider` to
    // a client that never asked, and the Calls tab is gated on that provider -
    // so dropping this block hides the tab against a *correct* server.
    expect(td.callHierarchy).toBeTruthy();
    // Wave 7 Phase 9. Both halves, and the second is a promise rather than a
    // preference: `refreshSupport` tells the server it may push
    // `workspace/codeLens/refresh` instead of leaving Tori to guess when a
    // reference count went stale, and `lspClient`'s router is what makes that
    // true. Declaring it and answering `-32601` would be worse than not
    // declaring it, since a conformant server stops asking.
    expect(td.codeLens).toBeTruthy();
    expect((ws.codeLens as { refreshSupport?: unknown }).refreshSupport).toBe(true);
    expect(ws.applyEdit).toBe(true);
  });
});

// ------------------------------------------- the parts copied from the library

describe("the behaviour carried over from serverCompletionSource", () => {
  it("inserts a plain item's label", async () => {
    const { view } = await setup("con");
    completionReply = { items: [{ label: "console", kind: 6 }] };
    accept(view, await complete(view));

    expect(view.state.doc.toString()).toBe("console");
  });

  it("prefers textEdit.newText over the label, and takes the range from itemDefaults", async () => {
    // `itemDefaults.editRange` is why the client declares `completionList.itemDefaults`
    // at all: without honouring it, every item replaces the word the caret is
    // in rather than the range the server computed.
    const { view } = await setup("obj.fo");
    completionReply = {
      itemDefaults: { editRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } } },
      items: [{ label: "foo", textEdit: { newText: "foo" } }],
    };
    accept(view, await complete(view));

    expect(view.state.doc.toString()).toBe("obj.foo");
  });

  it("expands a snippet, taking the format from itemDefaults", async () => {
    // LSP's `$1` is CodeMirror's `${1}`. A server that sets the format on the
    // list rather than on each item is the case a per-item read would miss.
    const { view } = await setup("");
    completionReply = {
      itemDefaults: { insertTextFormat: 2 },
      items: [{ label: "log", insertText: "console.log($1)" }],
    };
    accept(view, await complete(view));

    expect(view.state.doc.toString()).toBe("console.log()");
  });

  it("applies additionalTextEdits that arrive with the list, without resolving", async () => {
    // A server that answers everything up front needs no second round trip, and
    // asking for one anyway would cost a request per accepted completion.
    const { view } = await setup("const a = 1\n");
    completionReply = {
      items: [
        {
          label: "useMemo",
          additionalTextEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import { useMemo } from 'react'\n",
            },
          ],
        },
      ],
    };
    accept(view, await complete(view));
    await settle();

    expect(view.state.doc.toString()).toBe("import { useMemo } from 'react'\nconst a = 1\nuseMemo");
    expect(asked("completionItem/resolve")).toHaveLength(0);
  });

  it("offers no completions when the server advertises no provider", async () => {
    capabilities = {};
    const { view } = await setup("con");
    const result = await toriCompletionSource(new CompletionContext(view.state, 3, true, view));

    expect(result).toBeNull();
    expect(asked("textDocument/completion")).toHaveLength(0);
  });

  it("asks only on a trigger character or an identifier when it was not invoked", async () => {
    const { view } = await setup("a b.");
    // A space is neither, so an implicit completion there is not a request.
    expect(await toriCompletionSource(new CompletionContext(view.state, 2, false, view))).toBeNull();
    // The server named "." a trigger character.
    completionReply = { items: [{ label: "x" }] };
    expect(await toriCompletionSource(new CompletionContext(view.state, 4, false, view))).toBeTruthy();
    expect(asked("textDocument/completion")[0].params.context).toEqual({
      triggerKind: 2,
      triggerCharacter: ".",
    });
  });
});

// ------------------------------------------- the part that is new

describe("auto-import through completionItem/resolve", () => {
  const IMPORT = "import { useMemo } from 'react'\n";
  const importOnResolve = (line: number) => (item: Record<string, unknown>) => ({
    ...item,
    additionalTextEdits: [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, newText: IMPORT }],
  });

  it("inserts both the identifier and the import line", async () => {
    // The whole point: tsserver leaves `additionalTextEdits` out of a list of
    // two hundred items and hands them over only for the one that was chosen.
    const { view } = await setup("const a = 1\n");
    completionReply = { items: [{ label: "useMemo", data: { entry: 7 } }] };
    resolveWith = importOnResolve(0);

    accept(view, await complete(view));
    expect(view.state.doc.toString()).toBe("const a = 1\nuseMemo");
    await settle();

    expect(view.state.doc.toString()).toBe(`${IMPORT}const a = 1\nuseMemo`);
  });

  it("sends the item back whole, so the server's own data round-trips", async () => {
    // `data` is opaque and is how the server finds the entry again. Sending a
    // trimmed item is how a resolve comes back empty against a correct server.
    const { view } = await setup("");
    completionReply = { items: [{ label: "useMemo", data: { entry: 7, file: "react.d.ts" } }] };
    accept(view, await complete(view));
    await settle();

    expect(asked("completionItem/resolve")[0].params).toMatchObject({
      label: "useMemo",
      data: { entry: 7, file: "react.d.ts" },
    });
  });

  it("syncs before resolving, so the server computes the import against the committed text", async () => {
    // Without the sync tsserver answers from the document as it was before the
    // commit, where the identifier is still half-typed - and can decide no
    // import is needed at all.
    const { view } = await setup("useM");
    completionReply = { items: [{ label: "useMemo" }] };
    accept(view, await complete(view));
    await settle();

    // The order on the wire is the assertion: a `didChange` carrying the
    // committed text, and only then the resolve. The library's own sync is
    // debounced by 500 ms, so without the explicit one the resolve overtakes it.
    const didChange = wire.findIndex(
      (f) => f.method === "textDocument/didChange" && JSON.stringify(f.params).includes("useMemo"),
    );
    const resolve = wire.findIndex((f) => f.method === "completionItem/resolve");

    expect(didChange).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeGreaterThan(didChange);
  });

  it("places the import correctly when the user keeps typing while the resolve is out", async () => {
    // The reply names positions in the document the server was last told
    // about. Anything typed since moves them, and an import spliced into the
    // middle of a line is the failure this prevents.
    holdResolve = true;
    const { view } = await setup("const a = 1\n");
    completionReply = { items: [{ label: "useMemo" }] };
    resolveWith = importOnResolve(1); // the line the server saw `useMemo` land on

    accept(view, await complete(view));
    await settle();
    // A newline typed above, before the reply comes back.
    view.dispatch({ changes: { from: 0, to: 0, insert: "// note\n" } });

    held.forEach((h) => h());
    await settle();

    expect(view.state.doc.toString()).toBe(`// note\nconst a = 1\n${IMPORT}useMemo`);
  });

  it("never asks a server that offers no resolveProvider", async () => {
    // The request would draw a MethodNotFound, once per accepted completion.
    capabilities = { completionProvider: { resolveProvider: false } };
    const { view } = await setup("");
    completionReply = { items: [{ label: "useMemo" }] };
    accept(view, await complete(view));
    await settle();

    expect(asked("completionItem/resolve")).toHaveLength(0);
    expect(view.state.doc.toString()).toBe("useMemo");
  });

  it("keeps the identifier and says so once when the resolve is refused", async () => {
    // Fail soft: the identifier is already in the document by the time the
    // resolve runs, so a refusal costs a convenience, not an edit. A dialog
    // here would interrupt typing to report something the user did not ask for.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveError = { code: -32603, message: "internal error" };
    const { view } = await setup("");
    completionReply = { items: [{ label: "useMemo" }] };

    accept(view, await complete(view));
    await settle();

    expect(view.state.doc.toString()).toBe("useMemo");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("gives up on a resolve that never answers, without losing the identifier", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      holdResolve = true; // answered by nobody
      const { view } = await setup("");
      completionReply = { items: [{ label: "useMemo" }] };

      accept(view, await complete(view));
      expect(view.state.doc.toString()).toBe("useMemo");
      await vi.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS + 1);

      expect(view.state.doc.toString()).toBe("useMemo");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the edit when the buffer it was asked about is no longer on screen", async () => {
    // One `EditorView`, reconfigured per tab. A resolve for `a.ts` landing
    // after the user switched to `b.ts` would put an import line into a file
    // that never asked for one, with no keystroke anywhere near it.
    holdResolve = true;
    const { client, view } = await setup("const a = 1\n");
    completionReply = { items: [{ label: "useMemo" }] };
    resolveWith = importOnResolve(0);

    accept(view, await complete(view));
    await settle();

    // The tab swap: a new document, and the plugin rebuilt for the other file.
    view.setState(
      EditorState.create({
        doc: "other file\n",
        extensions: [client.plugin("file:///proj/b.ts", "typescript")],
      }),
    );
    held.forEach((h) => h());
    await settle();

    expect(view.state.doc.toString()).toBe("other file\n");
  });

  it("applies all of a multi-edit resolve or none of it", async () => {
    // Half an import is worse than none: nothing on screen says which half
    // landed, and the file no longer compiles either way.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view } = await setup("const a = 1\n");
    completionReply = { items: [{ label: "useMemo" }] };
    resolveWith = (item) => ({
      ...item,
      additionalTextEdits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: IMPORT },
        // A line the document does not have, which is what a server working
        // from a stale copy sends.
        { range: { start: { line: 99, character: 0 }, end: { line: 99, character: 0 } }, newText: "late\n" },
      ],
    });

    accept(view, await complete(view));
    await settle();

    expect(view.state.doc.toString()).toBe("const a = 1\nuseMemo");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses a range the document accepts but should not, rather than reversing it", async () => {
    // An inverted range is the malformed case `mapPosition` does *not* catch:
    // both ends map to real offsets. What refuses it is CodeMirror, when the
    // whole set is dispatched as one transaction - which is the reason there is
    // no bounds check of Tori's own in that loop.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view } = await setup("const a = 1\n");
    completionReply = { items: [{ label: "useMemo" }] };
    resolveWith = (item) => ({
      ...item,
      additionalTextEdits: [
        { range: { start: { line: 0, character: 9 }, end: { line: 0, character: 2 } }, newText: "x" },
      ],
    });

    accept(view, await complete(view));
    await settle();

    expect(view.state.doc.toString()).toBe("const a = 1\nuseMemo");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("marks the insertion as a picked completion, the way autocomplete would have", async () => {
    // The wrapper takes over `apply` for every item on a resolve-capable
    // server, which means it takes over the default insertion too - and the
    // annotation is the half CodeMirror adds *around* `insertCompletionText`
    // rather than inside it. Nothing reads it while `activateOnCompletion`
    // stays at its default, which is exactly why losing it would go unnoticed.
    const picked: (Completion | undefined)[] = [];
    const watch = EditorView.updateListener.of((u) => {
      for (const tr of u.transactions) picked.push(tr.annotation(pickedCompletion));
    });
    const { view } = await setup("", watch);
    completionReply = { items: [{ label: "useMemo" }] };

    accept(view, await complete(view));

    expect(picked.filter(Boolean).map((c) => c!.label)).toEqual(["useMemo"]);
  });

  it("tells the server to stop when it gives up waiting", async () => {
    // Otherwise the server goes on computing an import for a keystroke that has
    // already been answered without one, on the same thread as the next
    // completion request.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      holdResolve = true;
      const { view } = await setup("");
      completionReply = { items: [{ label: "useMemo" }] };

      accept(view, await complete(view));
      await vi.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS + 1);

      const cancel = wire.find((f) => f.method === "$/cancelRequest");
      const resolve = sent.find((s) => s.method === "completionItem/resolve");
      expect(cancel).toBeTruthy();
      expect(cancel!.params.id).toBe(resolve!.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a snippet item its import too, when the list carried one", async () => {
    // The library drops it: its snippet branch wins outright and never reads
    // `additionalTextEdits`, and because the item *has* edits nothing resolves
    // it either. Both mechanisms decline, so the import silently never lands.
    const { view } = await setup("const a = 1\n");
    completionReply = {
      items: [
        {
          label: "useMemo",
          insertText: "useMemo($1)",
          insertTextFormat: 2,
          additionalTextEdits: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: IMPORT },
          ],
        },
      ],
    };

    accept(view, await complete(view));
    await settle();

    expect(view.state.doc.toString()).toBe(`${IMPORT}const a = 1\nuseMemo()`);
    // It carried its edits, so there was nothing left to ask for.
    expect(asked("completionItem/resolve")).toHaveLength(0);
  });

  it("resolves a snippet item too", async () => {
    // An item is not less likely to need an import for having placeholders in
    // it, which is why the resolve wraps the apply rather than living inside
    // one of its branches.
    const { view } = await setup("");
    completionReply = {
      items: [{ label: "useMemo", insertText: "useMemo($1)", insertTextFormat: 2 }],
    };
    resolveWith = importOnResolve(0);

    accept(view, await complete(view));
    await settle();

    expect(view.state.doc.toString()).toBe(`${IMPORT}useMemo()`);
  });
});

// ------------------------------------------- the small pure pieces

describe("the pure helpers", () => {
  it("converts LSP snippet syntax to CodeMirror's", () => {
    expect(lspToSnippet("log($1, $2)")).toBe("log(${1}, ${2})");
    // A backslash-escaped `$` is a literal one, and CodeMirror has no escape
    // for it, so the backslash goes and the `$` stays.
    expect(lspToSnippet("cost: \\$5")).toBe("cost: $5");
  });

  it("refuses a position the document does not have rather than clamping to one", () => {
    const doc = EditorState.create({ doc: "ab\ncd" }).doc;
    expect(offsetOf(doc, { line: 1, character: 1 })).toBe(4);
    expect(offsetOf(doc, { line: 2, character: 0 })).toBeNull();
    expect(offsetOf(doc, { line: 0, character: 9 })).toBeNull();
    expect(offsetOf(doc, { line: -1, character: 0 })).toBeNull();
  });

  it("builds a validFor covering the non-word prefixes the list actually uses", () => {
    // Without it, typing `#` after opening the popup throws the whole list away
    // and asks the server again for every keystroke.
    expect(prefixRegexp([{ label: "foo" }]).source).toBe("^\\w*$");
    const hashed = prefixRegexp([{ label: "#private" }, { label: "foo" }]);
    expect(hashed.test("#priv")).toBe(true);
    expect(hashed.test("foo")).toBe(true);
  });
});
