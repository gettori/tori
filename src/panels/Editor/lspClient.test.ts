import { describe, it, expect, vi, beforeEach } from "vitest";

// The client's lifecycle signal, which is what lets a file opened before the
// language server was ready still get LSP. Everything below the module (Tauri
// and @codemirror/lsp-client) is stubbed: what is asserted here is strictly
// when `onLspChange` fires, because a missed transition leaves a buffer holding
// a plugin for a server that is gone.

const started: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "lsp_start") started.push(String(args?.projectPath));
    return Promise.resolve();
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));

vi.mock("@codemirror/lsp-client", () => ({
  LSPClient: class {
    connect() {
      return this;
    }
    disconnect() {}
    // A marker rather than an extension: the assertions only need to tell
    // "attached, for this uri" apart from "attached nothing".
    plugin(uri: string) {
      return { uri };
    }
  },
  languageServerExtensions: () => [],
}));

import { ensureLsp, onLspChange, lspPluginFor } from "./lspClient";

beforeEach(() => {
  started.length = 0;
});

describe("onLspChange", () => {
  it("fires when the client comes up", async () => {
    let fired = 0;
    const off = onLspChange(() => (fired += 1));
    await ensureLsp("/proj/a");
    expect(fired).toBe(1);
    off();
  });

  it("fires twice on a project switch: once for the teardown, once for the replacement", async () => {
    let fired = 0;
    const off = onLspChange(() => (fired += 1));
    await ensureLsp("/proj/b");
    // The old client is dropped before the new one exists, so a buffer sheds
    // its dead plugin rather than briefly holding one for a dead server.
    expect(fired).toBe(2);
    off();
  });

  it("does not fire when the same root is reused", async () => {
    await ensureLsp("/proj/c");
    let fired = 0;
    const off = onLspChange(() => (fired += 1));
    await ensureLsp("/proj/c");
    expect(fired).toBe(0);
    // Reuse short-circuits before the server is asked to start again.
    expect(started).toEqual(["/proj/c"]);
    off();
  });

  it("stops firing after unsubscribe", async () => {
    let fired = 0;
    const off = onLspChange(() => (fired += 1));
    await ensureLsp("/proj/d");
    const atUnsubscribe = fired;
    off();
    await ensureLsp("/proj/e");
    expect(fired).toBe(atUnsubscribe);
  });

  it("lets a watcher unsubscribe from inside its own call without skipping the next one", async () => {
    const seen: string[] = [];
    const offFirst = onLspChange(() => {
      seen.push("first");
      offFirst();
    });
    const offSecond = onLspChange(() => seen.push("second"));
    await ensureLsp("/proj/f");
    expect(seen.slice(0, 2)).toEqual(["first", "second"]);
    expect(seen.filter((s) => s === "first")).toHaveLength(1);
    offSecond();
  });
});

describe("lspPluginFor", () => {
  it("attaches nothing before the client is up", async () => {
    // The precondition of the bug this module exists to fix: a file opened this
    // early gets no plugin, so the buffer must hold it in a compartment and take
    // it on the `onLspChange` fire rather than baking this answer in for good.
    vi.resetModules();
    const fresh = await import("./lspClient");
    expect(fresh.lspPluginFor("/proj/z/src/a.ts")).toEqual([]);
  });

  it("attaches for a TS/JS file under the active root", async () => {
    await ensureLsp("/proj/g");
    expect(lspPluginFor("/proj/g/src/a.ts")).toEqual({ uri: "file:///proj/g/src/a.ts" });
  });

  it("returns nothing for a non-TS/JS extension", async () => {
    await ensureLsp("/proj/h");
    expect(lspPluginFor("/proj/h/README.md")).toEqual([]);
  });

  it("returns nothing for a TS file outside the active root", async () => {
    await ensureLsp("/proj/i");
    // A Docs-tree or .shared/ file lives outside the project the server was
    // started for; asking it about one would answer from the wrong project.
    expect(lspPluginFor("/elsewhere/notes/a.ts")).toEqual([]);
  });
});
