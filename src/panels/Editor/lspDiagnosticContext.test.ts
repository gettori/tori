import { describe, it, expect, beforeEach } from "vite-plus/test";
import { LSPClient, type Transport } from "@codemirror/lsp-client";
import {
  clearDiagnosticContext,
  diagnosticContextCapture,
  diagnosticsIn,
  rememberDiagnostics,
} from "./lspDiagnosticContext";

// The point of this module is one thing the lint state cannot do: hand a server
// back its own `code` and `data`. Every test here is about that survival, or
// about the store not growing without bound while doing it.

const at = (line: number, character: number) => ({ line, character });
const range = (sl: number, sc: number, el: number, ec: number) => ({ start: at(sl, sc), end: at(el, ec) });

const publish = (uri: string, diagnostics: unknown[]) =>
  diagnosticContextCapture("ts").notificationHandlers["textDocument/publishDiagnostics"](null, {
    uri,
    diagnostics,
  });

beforeEach(() => clearDiagnosticContext());

describe("capturing a publish", () => {
  it("declines the notification so the library still renders it", () => {
    // Returning true would consume the frame and the squiggles would vanish:
    // the client stops at the first handler that claims a notification.
    expect(publish("file:///a.ts", [{ range: range(0, 0, 0, 1), message: "x" }])).toBe(false);
  });

  it("keeps the fields CodeMirror throws away", () => {
    // `serverDiagnostics()` converts a publish to {from,to,severity,message}.
    // `code` is what tsserver matches a quick fix on, so a context rebuilt from
    // the lint state would ask every server a question it cannot answer.
    publish("file:///a.ts", [
      { range: range(2, 4, 2, 9), message: "Cannot find name 'foo'.", code: 2304, source: "ts", data: { fix: 1 } },
    ]);

    const [d] = diagnosticsIn("file:///a.ts", "ts", range(2, 5, 2, 5));
    expect(d.code).toBe(2304);
    expect(d.source).toBe("ts");
    expect(d.data).toEqual({ fix: 1 });
  });

  it("forgets a file the server has cleared", () => {
    // The resting state of nearly every file, so storing it would leave one
    // entry per file in a monorepo-wide publish for the life of the session.
    publish("file:///a.ts", [{ range: range(0, 0, 0, 1), message: "x" }]);
    publish("file:///a.ts", []);
    expect(diagnosticsIn("file:///a.ts", "ts", range(0, 0, 0, 1))).toEqual([]);
  });

  it("ignores a publish naming no file", () => {
    expect(publish(undefined as unknown as string, [])).toBe(false);
    expect(() => diagnosticsIn("file:///a.ts", "ts", range(0, 0, 0, 0))).not.toThrow();
  });

  it("treats a missing diagnostics array as a clear, not as a crash", () => {
    publish("file:///a.ts", [{ range: range(0, 0, 0, 1), message: "x" }]);
    diagnosticContextCapture("ts").notificationHandlers["textDocument/publishDiagnostics"](null, {
      uri: "file:///a.ts",
    });
    expect(diagnosticsIn("file:///a.ts", "ts", range(0, 0, 0, 1))).toEqual([]);
  });
});

describe("which diagnostics a range is asked about", () => {
  beforeEach(() => {
    rememberDiagnostics("file:///a.ts", "ts", [
      { range: range(1, 0, 1, 5), message: "first" },
      { range: range(5, 2, 5, 8), message: "second" },
      { range: range(9, 0, 12, 0), message: "spanning" },
    ]);
  });

  const messages = (r: ReturnType<typeof range>) => diagnosticsIn("file:///a.ts", "ts", r).map((d) => d.message);

  it("answers with the one the caret sits inside", () => {
    expect(messages(range(5, 4, 5, 4))).toEqual(["second"]);
  });

  it("counts a caret touching either end, since that is where a fix is asked for", () => {
    expect(messages(range(1, 0, 1, 0))).toEqual(["first"]);
    expect(messages(range(1, 5, 1, 5))).toEqual(["first"]);
  });

  it("answers with every one a selection crosses", () => {
    expect(messages(range(1, 2, 5, 3))).toEqual(["first", "second"]);
  });

  it("answers with a multi-line one from a caret in its middle", () => {
    expect(messages(range(10, 3, 10, 3))).toEqual(["spanning"]);
  });

  it("answers nothing for a range between two of them", () => {
    expect(messages(range(3, 0, 3, 1))).toEqual([]);
  });

  it("answers nothing for a file nothing was published for", () => {
    expect(diagnosticsIn("file:///b.ts", "ts", range(0, 0, 0, 0))).toEqual([]);
  });

  it("skips an entry carrying no range rather than throwing", () => {
    rememberDiagnostics("file:///c.ts", "ts", [{ message: "rangeless" }]);
    expect(diagnosticsIn("file:///c.ts", "ts", range(0, 0, 0, 0))).toEqual([]);
  });
});

describe("the dispatch rule this module's placement rests on", () => {
  // Two claims hold this module up, and both are the library's, not Tori's:
  // `receiveMessage` tries each extension's notification handler in order and
  // **stops at the first that returns true** (`dist/index.js:670-676`). That is
  // why the capture is registered ahead of `languageServerExtensions()` and why
  // it returns false. A hand-rolled copy of that loop would pass while the real
  // one did not, so it is checked against the real client here.
  //
  // What is deliberately *not* asserted here is that `serverDiagnostics()`
  // itself would swallow the publish: it only claims one for a file the
  // workspace has open in a view, which needs a mounted editor. The order in
  // Tori's own extension list is pinned in `lspClient.test.ts` instead.
  const probe = (name: string, claim: boolean, seen: string[]) => ({
    notificationHandlers: {
      "textDocument/publishDiagnostics": () => {
        seen.push(name);
        return claim;
      },
    },
  });

  function feedPublish(extensions: unknown[]) {
    let handler: ((msg: string) => void) | null = null;
    const transport: Transport = {
      send: () => {},
      subscribe: (h) => (handler = h),
      unsubscribe: () => {},
    };
    new LSPClient({
      rootUri: "file:///proj",
      extensions: extensions as never,
    }).connect(transport);
    handler!(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: "file:///proj/a.ts", diagnostics: [{ range: range(0, 0, 0, 3), message: "boom", code: 2304 }] },
      }),
    );
  }

  it("stops at the first handler that claims the notification", () => {
    const seen: string[] = [];
    feedPublish([probe("first", true, seen), probe("second", false, seen)]);
    expect(seen, "the second never ran").toEqual(["first"]);
  });

  it("carries on past a handler that declines, which is why the capture returns false", () => {
    const seen: string[] = [];
    feedPublish([diagnosticContextCapture("ts"), probe("after", false, seen)]);

    expect(seen, "the library's own renderer still gets its turn").toEqual(["after"]);
    expect(diagnosticsIn("file:///proj/a.ts", "ts", range(0, 1, 0, 1)).map((d) => d.code)).toEqual([2304]);
  });
});

describe("clearing", () => {
  it("drops everything, since a project switch invalidates every server", () => {
    rememberDiagnostics("file:///a.ts", "ts", [{ range: range(0, 0, 0, 1), message: "x" }]);
    clearDiagnosticContext();
    expect(diagnosticsIn("file:///a.ts", "ts", range(0, 0, 0, 1))).toEqual([]);
  });
});
