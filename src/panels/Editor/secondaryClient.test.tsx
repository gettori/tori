import { describe, it, expect, vi, afterEach } from "vitest";
import { LSPClient, LSPPlugin, type Transport } from "@codemirror/lsp-client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SecondaryClient, secondaryFeed, type Publish } from "./secondaryClient";

const PATH = "/proj/a.ts";
const URI = "file:///proj/a.ts";

type Frame = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

function fakeServer(capabilities: Record<string, unknown> = { textDocumentSync: 2 }, pulled: unknown[] = []) {
  const wire: Frame[] = [];
  const published: Publish[] = [];
  let client: SecondaryClient | null = null;
  const reply = (id: number | undefined, result: unknown) =>
    queueMicrotask(() => client!.receive(JSON.stringify({ jsonrpc: "2.0", id, result })));
  client = new SecondaryClient({
    send: (message) => {
      const frame = JSON.parse(message) as Frame;
      wire.push(frame);
      if (frame.method === "initialize") reply(frame.id, { capabilities });
      if (frame.method === "textDocument/diagnostic") reply(frame.id, { kind: "full", items: pulled });
    },
    rootUri: "file:///proj",
    timeoutMs: 1000,
    settings: { validate: "on" },
    initializationOptions: null,
    onDiagnostics: (p) => published.push(p),
  });
  return { client, wire, published };
}

// A primary built the way the app builds one, so the test can see whether the
// secondary's syncing ever touches the library plugin's own change tracking.
function primary(): LSPClient {
  const transport: Transport = {
    send: (message) => {
      const frame = JSON.parse(message) as Frame;
      if (frame.method === "initialize") {
        queueMicrotask(() => receive?.(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { capabilities: {} } })));
      }
    },
    subscribe: (h) => (receive = h),
    unsubscribe: () => {},
  };
  let receive: ((msg: string) => void) | null = null;
  return new LSPClient({ rootUri: "file:///proj" }).connect(transport);
}

let views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
  vi.useRealTimers();
});

function viewOver(doc: string, client: SecondaryClient, lsp = primary()) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        lsp.plugin(URI, "typescript"),
        secondaryFeed.of({ path: PATH, targets: () => [{ client, languageId: "typescript" }] }),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const sync = (wire: Frame[]) => wire.filter((f) => f.method?.startsWith("textDocument/did"));

describe("SecondaryClient", () => {
  it("opens the buffer and sends its edits in order, each at the next version", async () => {
    const { client, wire } = fakeServer();
    const view = viewOver("const a = 1;\n", client);
    await client.initializing;
    vi.useFakeTimers();

    view.dispatch({ changes: { from: 0, insert: "// x\n" } });
    vi.advanceTimersByTime(500);
    view.dispatch({ changes: { from: 5, to: 10, insert: "let" } });
    vi.advanceTimersByTime(500);

    const frames = sync(wire);
    expect(wire.map((f) => f.method).slice(0, 3)).toEqual([
      "initialize",
      "initialized",
      "workspace/didChangeConfiguration",
    ]);
    expect(frames.map((f) => f.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didChange",
    ]);
    expect(frames.map((f) => (f.params?.textDocument as { version: number }).version)).toEqual([0, 1, 2]);
    expect(frames[2].params?.contentChanges).toEqual([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, text: "let" },
    ]);
    expect(client.held(PATH)?.toString()).toBe("// x\nlet a = 1;\n");
  });

  it("leaves the primary's unsynced changes for the primary to send", async () => {
    const { client, wire } = fakeServer();
    const view = viewOver("abc", client);
    await client.initializing;
    vi.useFakeTimers();

    view.dispatch({ changes: { from: 3, insert: "d" } });
    vi.advanceTimersByTime(500);

    expect(sync(wire).map((f) => f.method)).toEqual(["textDocument/didOpen", "textDocument/didChange"]);
    const plugin = LSPPlugin.get(view)!;
    expect(plugin.unsyncedChanges.empty).toBe(false);
    expect(plugin.syncedDoc.toString()).toBe("abc");
  });

  it("asks a server that only answers pulls, after each sync and when it says to ask again", async () => {
    const unused = { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, message: "unused" };
    const { client, wire, published } = fakeServer({ textDocumentSync: 2, diagnosticProvider: {} }, [unused]);
    viewOver("const a = 1;\n", client);
    await client.initializing;
    await vi.waitFor(() => expect(published).toHaveLength(1));

    expect(published[0]).toEqual({ uri: URI, path: PATH, version: 0, diagnostics: [unused] });
    const methods = wire.map((f) => f.method);
    expect(methods.indexOf("textDocument/diagnostic")).toBeGreaterThan(methods.indexOf("textDocument/didOpen"));

    client.receive(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "workspace/diagnostic/refresh" }));
    await vi.waitFor(() => expect(published).toHaveLength(2));
    expect(wire).toContainEqual({ jsonrpc: "2.0", id: 99, result: null });
  });

  it("answers the requests a server makes of it, and refuses only what it does not know", async () => {
    const { client, wire } = fakeServer();
    await client.initializing;
    wire.length = 0;

    for (const [id, method] of [
      [1, "client/registerCapability"],
      [2, "window/workDoneProgress/create"],
      [3, "eslint/noConfig"],
      [4, "eslint/somethingNew"],
      [5, "workspace/configuration"],
      [6, "unknown/method"],
    ] as const) {
      client.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params: { items: [{ section: "" }] } }));
    }

    expect(wire.slice(0, 5)).toEqual([
      { jsonrpc: "2.0", id: 1, result: null },
      { jsonrpc: "2.0", id: 2, result: null },
      { jsonrpc: "2.0", id: 3, result: null },
      { jsonrpc: "2.0", id: 4, result: null },
      { jsonrpc: "2.0", id: 5, result: [{ validate: "on" }] },
    ]);
    expect((wire[5].error as { code: number }).code).toBe(-32601);
  });
});
