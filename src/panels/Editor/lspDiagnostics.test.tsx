import { describe, it, expect, vi, afterEach } from "vitest";
import { forEachDiagnostic } from "@codemirror/lint";
import { LSPClient, type Transport } from "@codemirror/lsp-client";
import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve(null),
  convertFileSrc: (p: string) => p,
  Channel: class {
    onmessage: unknown = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { clientExtensions } = await import("./lspClient");
const { publishFrom, toEditorDiagnostics } = await import("./lspDiagnostics");
const { ToriWorkspace } = await import("./toriWorkspace");

const URI = "file:///proj/a.ts";
const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

function shown(state: EditorState) {
  const out: { text: string; source?: string }[] = [];
  forEachDiagnostic(state, (d, from, to) => out.push({ text: state.sliceDoc(from, to), source: d.source }));
  return out;
}

describe("publishFrom", () => {
  it("keeps one server's diagnostics when another republishes empty", () => {
    let state = EditorState.create({ doc: "let a = 1;\nlet b = 2;\n" });
    const none = ChangeSet.empty(state.doc.length).desc;
    const peers = ["typescript", "eslint"];
    const say = (serverId: string, raw: { range: ReturnType<typeof range>; message: string }[]) => {
      state = state.update(publishFrom(state, serverId, toEditorDiagnostics(raw, state.doc, none, serverId), peers)).state;
    };

    say("typescript", [{ range: range(0, 4, 0, 5), message: "type" }]);
    say("eslint", [{ range: range(1, 4, 1, 5), message: "unused" }]);
    expect(shown(state)).toEqual([
      { text: "a", source: "typescript" },
      { text: "b", source: "eslint" },
    ]);

    say("eslint", []);
    expect(shown(state)).toEqual([{ text: "a", source: "typescript" }]);
  });
});

describe("a publish for an older version", () => {
  let views: EditorView[] = [];
  afterEach(() => {
    for (const v of views) v.destroy();
    views = [];
  });

  async function setup(doc: string) {
    let receive: ((msg: string) => void) | null = null;
    const transport: Transport = {
      send: (message) => {
        const frame = JSON.parse(message) as { id?: number; method?: string };
        if (frame.method !== "initialize") return;
        const result = { capabilities: { textDocumentSync: 2 } };
        queueMicrotask(() => receive?.(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })));
      },
      subscribe: (h) => (receive = h),
      unsubscribe: () => {},
    };
    const client = new LSPClient({
      extensions: clientExtensions("typescript"),
      workspace: (c) =>
        new ToriWorkspace(c, {
          bufferText: () => null,
          diskText: () => Promise.resolve(null),
          languageId: () => "typescript",
          requestOpen: () => {},
        }),
    }).connect(transport);
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [client.plugin(URI, "typescript")] }),
      parent: document.body,
    });
    views.push(view);
    await client.initializing;
    const publish = (version: number, diagnostics: unknown[]) =>
      receive?.(
        JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version, diagnostics } }),
      );
    return { client, view, publish };
  }

  it("lands on the text it was about after a large delete, and drops what the delete removed", async () => {
    const { client, view, publish } = await setup("aaaa\nbbbb\ncccc\ndddd\n");
    view.dispatch({ changes: { from: 0, to: 10 } });
    client.sync();

    expect(() =>
      publish(0, [
        { range: range(1, 0, 1, 4), message: "gone" },
        { range: range(3, 0, 3, 4), message: "moved" },
        { range: range(3, 2, 3, 99), message: "past the line" },
        { range: range(40, 0, 41, 0), message: "past the file" },
      ]),
    ).not.toThrow();

    const doc = view.state.doc;
    const list: { from: number; to: number; message: string }[] = [];
    forEachDiagnostic(view.state, (d, from, to) => list.push({ from, to, message: d.message }));
    expect(list.every((d) => d.from >= 0 && d.to <= doc.length)).toBe(true);
    expect(list.map((d) => d.message)).not.toContain("gone");
    const moved = list.find((d) => d.message === "moved")!;
    expect(view.state.sliceDoc(moved.from, moved.to)).toBe("dddd");
  });
});
