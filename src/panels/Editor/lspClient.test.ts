import { describe, it, expect, vi, beforeEach } from "vitest";

// The client's lifecycle signal, and which session answers for a given file.
// Everything below the module (Tauri and @codemirror/lsp-client) is stubbed:
// what is asserted here is strictly when `onLspChange` fires and what
// `lspPluginFor` attaches, because a missed transition leaves a buffer holding
// a plugin for a server that is gone, and a wrong session answers a file from
// another package's compiler config.

type StartArgs = { serverId: string; filePath: string; projectPath: string };

const started: StartArgs[] = [];
const stopped: string[] = [];
// Every frame the module wrote back to a server, and every Channel it handed to
// `lsp_start`. Together these are the only way to drive an incoming message and
// see what went out in reply, which is what the refresh interception is.
const sends: { handle: { serverId: string }; message: string }[] = [];
const channels: { onmessage: ((m: string) => void) | null }[] = [];
const clientConfigs: {
  rootUri?: string;
  timeout?: number;
  workspace?: (client: unknown) => unknown;
  extensions?: unknown[];
}[] = [];

// Two servers with disjoint extensions, mirroring the bundled pair. `rs` has a
// generous timeout the way rust.toml does; `ts` a smaller one.
let registry: unknown[] = [
  {
    id: "typescript",
    label: "TypeScript",
    languages: { ts: "typescript", tsx: "typescriptreact" },
    root_markers: ["tsconfig.json"],
    request_timeout_ms: 20000,
    launch: { kind: "path", program: "tsserver", args: [] },
    initialization_options: null,
    verified_against: null,
    source: "bundled:typescript",
  },
  {
    id: "rust",
    label: "Rust",
    languages: { rs: "rust" },
    root_markers: ["Cargo.toml"],
    request_timeout_ms: 90000,
    launch: { kind: "path", program: "rust-analyzer", args: [] },
    initialization_options: null,
    verified_against: null,
    source: "bundled:rust",
  },
];

// The root the fake backend resolves. Keyed by a prefix so a test can make two
// files collapse to one root, or split into two.
let resolveRoot: (args: StartArgs) => string = (a) => a.projectPath;

// Stands in for a registered server whose binary is not on this machine, which
// is the state `lsp_health` reports as `notFound`.
let startFails = false;

// When set, lsp_start blocks on this until the test releases it, so a teardown
// can be interleaved with a start that is already in flight.
let holdStart: Promise<void> | null = null;

// What `fs_read_file` finds. A path that is not here reads as unreadable, which
// is the state every file is in for the tests that never touch the workspace.
let disk: Record<string, string> = {};

// Every client the module built, so a test can reach the workspace that was
// handed to it. There is no other route: the session map is private.
const clients: {
  workspace: unknown;
  serverCapabilities: Record<string, unknown> | null;
  requests: { method: string; params: unknown }[];
  syncs: number;
  /** Frames that reached the library, i.e. that the transport fanned out. What
   *  the refresh interception is asserted *not* to appear in. */
  received: string[];
}[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "lsp_registry") return Promise.resolve(registry);
    if (cmd === "lsp_start") {
      const a = args as unknown as StartArgs;
      started.push({ serverId: a.serverId, filePath: a.filePath, projectPath: a.projectPath });
      if (startFails) return Promise.reject(new Error("`rust-analyzer` was not found on your PATH"));
      const result = { serverId: a.serverId, root: resolveRoot(a) };
      return holdStart ? holdStart.then(() => result) : Promise.resolve(result);
    }
    if (cmd === "fs_read_file") {
      const path = args?.path as string;
      return path in disk ? Promise.resolve(disk[path]) : Promise.reject(new Error("ENOENT"));
    }
    if (cmd === "lsp_send") {
      sends.push({
        handle: args?.handle as { serverId: string },
        message: args?.message as string,
      });
    }
    if (cmd === "lsp_stop_all") stopped.push("all");
    if (cmd === "lsp_stop") stopped.push((args?.handle as { serverId: string }).serverId);
    return Promise.resolve();
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
    constructor() {
      channels.push(this);
    }
  },
}));

vi.mock("@codemirror/lsp-client", () => ({
  // `SwayWorkspace` extends this, so it has to be a real constructor even
  // though nothing here exercises the library's own implementation.
  Workspace: class {
    constructor(readonly client: unknown) {}
  },
  LSPPlugin: { get: () => null },
  LSPClient: class {
    workspace: unknown;
    // What a symbol request reads off the session. Settled and provider-less by
    // default; a test that cares sets them on the captured client.
    serverCapabilities: Record<string, unknown> | null = null;
    initializing = Promise.resolve(null);
    requests: { method: string; params: unknown }[] = [];
    syncs = 0;
    received: string[] = [];
    constructor(config: (typeof clientConfigs)[number]) {
      clientConfigs.push(config);
      // The real client builds its workspace inside its own constructor, which
      // is what lets lspClient.ts capture it out of the factory. A stub that
      // never called the factory would leave every session workspace-less and
      // hide exactly the wiring these tests are here to check.
      this.workspace = config.workspace?.(this);
      clients.push(this);
    }
    // The real client subscribes here, and everything it is handed goes to
    // `receiveMessage`, which answers any request it did not expect with
    // -32601. A stub that ignored the transport would hide whether a frame the
    // module means to intercept ever reached the library at all.
    connect(transport: { subscribe: (h: (m: string) => void) => void }) {
      transport.subscribe((m) => this.received.push(m));
      return this;
    }
    didOpen() {}
    didClose() {}
    disconnect() {}
    sync() {
      this.syncs += 1;
    }
    request(method: string, params: unknown) {
      this.requests.push({ method, params });
      return Promise.resolve(null);
    }
    // A marker rather than an extension: the assertions only need to tell
    // "attached, for this uri and language" apart from "attached nothing".
    plugin(uri: string, languageId?: string) {
      return { uri, languageId };
    }
  },
  languageServerExtensions: () => [],
}));

async function freshModule() {
  vi.resetModules();
  return await import("./lspClient");
}

beforeEach(() => {
  started.length = 0;
  stopped.length = 0;
  clientConfigs.length = 0;
  clients.length = 0;
  sends.length = 0;
  channels.length = 0;
  disk = {};
  resolveRoot = (a) => a.projectPath;
  startFails = false;
  holdStart = null;
});

describe("onLspChange", () => {
  it("fires when a client comes up", async () => {
    const m = await freshModule();
    let fired = 0;
    const off = m.onLspChange(() => (fired += 1));
    await m.ensureLspFor("/proj/a/src/a.ts", "/proj/a");
    // Once for the registry landing, once for the session.
    expect(fired).toBeGreaterThanOrEqual(1);
    expect(m.lspPluginFor("/proj/a/src/a.ts")).not.toEqual([]);
    off();
  });

  it("fires when the registry lands, so a file opened first still attaches", async () => {
    const m = await freshModule();
    // Nothing claims the file before the registry resolves, which is exactly
    // the state a buffer built during startup sees.
    expect(m.lspPluginFor("/proj/r/src/a.ts")).toEqual([]);
    let fired = 0;
    const off = m.onLspChange(() => (fired += 1));
    await m.ensureLspFor("/proj/r/src/a.ts", "/proj/r");
    expect(fired).toBeGreaterThan(0);
    off();
  });

  it("fires on teardown so buffers shed a plugin pointing at a dead client", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/b/src/a.ts", "/proj/b");
    let fired = 0;
    const off = m.onLspChange(() => (fired += 1));
    await m.stopAllLsp();
    expect(fired).toBe(1);
    expect(m.lspPluginFor("/proj/b/src/a.ts")).toEqual([]);
    off();
  });

  it("does not fire when a second file reuses a live session", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/c/src/a.ts", "/proj/c");
    let fired = 0;
    const off = m.onLspChange(() => (fired += 1));
    await m.ensureLspFor("/proj/c/src/b.ts", "/proj/c");
    expect(fired).toBe(0);
    // The backend *is* asked again, because only it knows whether this file
    // resolves to the same root or a nearer one. What must not happen twice is
    // building a client: the reused session's Channel is the live one.
    expect(started).toHaveLength(2);
    expect(clientConfigs).toHaveLength(1);
    off();
  });

  it("stops firing after unsubscribe", async () => {
    const m = await freshModule();
    let fired = 0;
    const off = m.onLspChange(() => (fired += 1));
    await m.ensureLspFor("/proj/d/a.ts", "/proj/d");
    const atUnsubscribe = fired;
    off();
    await m.stopAllLsp();
    expect(fired).toBe(atUnsubscribe);
  });

  it("lets a watcher unsubscribe from inside its own call without skipping the next one", async () => {
    const m = await freshModule();
    const seen: string[] = [];
    const offFirst = m.onLspChange(() => {
      seen.push("first");
      offFirst();
    });
    const offSecond = m.onLspChange(() => seen.push("second"));
    await m.ensureLspFor("/proj/f/a.ts", "/proj/f");
    expect(seen.slice(0, 2)).toEqual(["first", "second"]);
    expect(seen.filter((s) => s === "first")).toHaveLength(1);
    offSecond();
  });
});

describe("lspPluginFor", () => {
  it("attaches nothing before any client is up", async () => {
    const m = await freshModule();
    expect(m.lspPluginFor("/proj/z/src/a.ts")).toEqual([]);
  });

  it("attaches with the language id the registry declares, not a guess", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/g/src/a.tsx", "/proj/g");
    expect(m.lspPluginFor("/proj/g/src/a.tsx")).toEqual({
      uri: "file:///proj/g/src/a.tsx",
      languageId: "typescriptreact",
    });
  });

  it("attaches for a Rust file under the project, from the Rust server", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/rs/src/main.rs", "/proj/rs");
    expect(m.lspPluginFor("/proj/rs/src/main.rs")).toEqual({
      uri: "file:///proj/rs/src/main.rs",
      languageId: "rust",
    });
    // ...and the same path outside every live root still gets nothing.
    expect(m.lspPluginFor("/elsewhere/src/main.rs")).toEqual([]);
  });

  it("attaches in place once the server comes up, for a buffer built before it", async () => {
    const m = await freshModule();
    const path = "/proj/late/src/main.rs";
    // The buffer is built here, and gets no plugin: this is the precondition
    // of the bug the compartment exists for.
    expect(m.lspPluginFor(path)).toEqual([]);

    let fired = 0;
    const off = m.onLspChange(() => (fired += 1));
    await m.ensureLspFor(path, "/proj/late");
    // The signal fired, which is what drives `relinkLsp`, and re-asking now
    // yields a real plugin without the file being closed and reopened.
    expect(fired).toBeGreaterThan(0);
    expect(m.lspPluginFor(path)).not.toEqual([]);
    off();
  });

  it("returns nothing for an extension no server claims", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/h/a.ts", "/proj/h");
    // A grammar exists for Python, but no server does. This is the supported
    // state, not a broken one.
    expect(m.lspPluginFor("/proj/h/main.py")).toEqual([]);
    expect(m.lspPluginFor("/proj/h/README.md")).toEqual([]);
  });

  it("returns nothing for a file outside every live root", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/i/a.ts", "/proj/i");
    // A Docs-tree or .shared/ file lives outside the project the server was
    // started for; asking it about one would answer from the wrong project.
    expect(m.lspPluginFor("/elsewhere/notes/a.ts")).toEqual([]);
  });

  it("a dotted directory cannot fake an extension", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/j/a.ts", "/proj/j");
    expect(m.lspPluginFor("/proj/j/some.ts/README")).toEqual([]);
    expect(m.lspPluginFor("/proj/j/.zshrc")).toEqual([]);
  });

  it("picks the most specific root when a file sits under two", async () => {
    const m = await freshModule();
    // A monorepo: the repo root came up first, then a package with its own
    // tsconfig. The package's server has the right compiler config.
    resolveRoot = () => "/mono";
    await m.ensureLspFor("/mono/README.ts", "/mono");
    resolveRoot = () => "/mono/packages/a";
    await m.ensureLspFor("/mono/packages/a/src/index.ts", "/mono");

    const attached = m.lspPluginFor("/mono/packages/a/src/index.ts") as unknown as { uri: string };
    expect(attached.uri).toBe("file:///mono/packages/a/src/index.ts");
    expect(started).toHaveLength(2);
    // The outer file still answers from the outer root.
    expect(m.lspPluginFor("/mono/README.ts")).not.toEqual([]);
  });
});

describe("lazy start", () => {
  it("opening only TS files never starts the Rust server", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/k/a.ts", "/proj/k");
    await m.ensureLspFor("/proj/k/b.tsx", "/proj/k");
    // rust-analyzer is never even asked about, let alone spawned: a project
    // with a Cargo.toml costs nothing until a .rs file is actually opened.
    expect(started.every((s) => s.serverId === "typescript")).toBe(true);
    expect(clientConfigs).toHaveLength(1);
  });

  it("starts a second server only when a file of its language is opened", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/l/a.ts", "/proj/l");
    await m.ensureLspFor("/proj/l/src/main.rs", "/proj/l");
    expect(started.map((s) => s.serverId)).toEqual(["typescript", "rust"]);
  });

  it("never starts for a file with no server, or one outside the project", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/m/main.py", "/proj/m");
    await m.ensureLspFor("/elsewhere/a.ts", "/proj/m");
    expect(started).toEqual([]);
  });

  it("serializes concurrent opens of one language into a single start", async () => {
    const m = await freshModule();
    // Both files resolve to the same root. Without serialization both would
    // call lsp_start before either registered a session, and the backend
    // reuses by handle without wiring the second caller's Channel, leaving
    // that client attached to a transport no frame ever reaches.
    await Promise.all([
      m.ensureLspFor("/proj/n/a.ts", "/proj/n"),
      m.ensureLspFor("/proj/n/b.ts", "/proj/n"),
    ]);
    expect(clientConfigs).toHaveLength(1);
  });

  it("starts different servers in parallel rather than queueing them", async () => {
    const m = await freshModule();
    await Promise.all([
      m.ensureLspFor("/proj/o/a.ts", "/proj/o"),
      m.ensureLspFor("/proj/o/main.rs", "/proj/o"),
    ]);
    expect(started.map((s) => s.serverId).sort()).toEqual(["rust", "typescript"]);
  });

  it("passes the file path so the backend, not the frontend, resolves the root", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/p/packages/a/src/index.ts", "/proj/p");
    expect(started[0].filePath).toBe("/proj/p/packages/a/src/index.ts");
    expect(started[0].projectPath).toBe("/proj/p");
  });
});

describe("per-server timeout", () => {
  it("uses each server's configured timeout, not the library's 3s default", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/q/a.ts", "/proj/q");
    await m.ensureLspFor("/proj/q/main.rs", "/proj/q");
    expect(clientConfigs.map((c) => c.timeout)).toEqual([20000, 90000]);
    // The default would take the whole client down on a cold rust-analyzer,
    // since the timeout covers `initialize` too.
    expect(clientConfigs.every((c) => c.timeout !== 3000)).toBe(true);
  });

  it("roots the client at the handle the backend resolved", async () => {
    const m = await freshModule();
    resolveRoot = () => "/proj/s/packages/a";
    await m.ensureLspFor("/proj/s/packages/a/index.ts", "/proj/s");
    expect(clientConfigs[0].rootUri).toBe("file:///proj/s/packages/a");
  });
});

describe("symbol capabilities", () => {
  it("advertises them on every client it builds", async () => {
    // The library advertises no symbol support at all, and a conformant server
    // offers no provider for something the client never asked for - so without
    // this the outline is empty against a *correct* server, which is the
    // hardest kind of wrong to notice.
    const m = await freshModule();
    await m.ensureLspFor("/proj/sym/a.ts", "/proj/sym");
    const caps = clientConfigs[0].extensions?.find(
      (e) => !!(e as { clientCapabilities?: unknown }).clientCapabilities,
    ) as { clientCapabilities: { textDocument: Record<string, unknown>; workspace: Record<string, unknown> } };
    expect(caps.clientCapabilities.textDocument.documentSymbol).toBeTruthy();
    expect(caps.clientCapabilities.workspace.symbol).toBeTruthy();
  });

  it("advertises semantic tokens alongside them, not instead of them", async () => {
    // Two separate capability extensions now, and the library merges them into
    // one payload. Passing only the later one would leave the outline empty
    // against a correct server while the colours worked, which is the kind of
    // half-failure nobody attributes to this line.
    const m = await freshModule();
    await m.ensureLspFor("/proj/sem/a.ts", "/proj/sem");
    const blocks = (clientConfigs[0].extensions ?? []).map(
      (e) => (e as { clientCapabilities?: { textDocument?: Record<string, unknown> } }).clientCapabilities,
    );
    expect(blocks.some((b) => b?.textDocument?.documentSymbol)).toBe(true);
    expect(blocks.some((b) => b?.textDocument?.semanticTokens)).toBe(true);
  });
});

describe("workspace/semanticTokens/refresh", () => {
  const refresh = (id: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "workspace/semanticTokens/refresh" });

  it("answers it rather than letting the library reject it", async () => {
    // `receiveMessage` replies -32601 to every server-initiated request, and
    // offers an extension point for notifications only - so the transport is
    // the only place this can be handled. A -32601 tells a conformant server
    // the client lied in its capabilities, and rust-analyzer's answer to that
    // is to stop asking, which is the whole feature.
    const m = await freshModule();
    await m.ensureLspFor("/proj/rf/a.ts", "/proj/rf");
    const roots: string[] = [];
    const off = m.setSemanticRefreshListener((root) => roots.push(root));
    channels[0].onmessage?.(refresh(7));
    expect(JSON.parse(sends[0].message)).toEqual({ jsonrpc: "2.0", id: 7, result: null });
    expect(sends[0].handle.serverId).toBe("typescript");
    expect(roots).toEqual(["/proj/rf"]);
    expect(clients[0].received).toEqual([]);
    off();
  });

  it("names the session that went stale, not just that one did", async () => {
    // The claim is that session's alone. In a monorepo a refresh from
    // `packages/a`'s server says nothing about a file `packages/b` answers for,
    // and a listener with no root would re-request on every one of them.
    const m = await freshModule();
    resolveRoot = (a) => (a.filePath.includes("/packages/a/") ? "/proj/mr/packages/a" : "/proj/mr");
    await m.ensureLspFor("/proj/mr/index.ts", "/proj/mr");
    await m.ensureLspFor("/proj/mr/packages/a/index.ts", "/proj/mr");
    const roots: string[] = [];
    m.setSemanticRefreshListener((root) => roots.push(root));
    channels[1].onmessage?.(refresh(2));
    expect(roots).toEqual(["/proj/mr/packages/a"]);
  });

  it("passes every other frame straight through", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/rf2/a.ts", "/proj/rf2");
    const diagnostic = JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {},
    });
    channels[0].onmessage?.(diagnostic);
    expect(clients[0].received).toEqual([diagnostic]);
    expect(sends).toEqual([]);
  });

  it("leaves a frame that merely mentions the method to the library", async () => {
    // A *response* naming the method, or a notification-shaped frame, is not
    // this to answer: replying to something that carries no id would put a
    // response with `"id": undefined` on the wire.
    const m = await freshModule();
    await m.ensureLspFor("/proj/rf3/a.ts", "/proj/rf3");
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { message: "workspace/semanticTokens/refresh handled" },
    });
    channels[0].onmessage?.(notification);
    expect(clients[0].received).toEqual([notification]);
    expect(sends).toEqual([]);
  });

  it("survives a frame that is not JSON at all", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/rf4/a.ts", "/proj/rf4");
    const junk = "workspace/semanticTokens/refresh";
    expect(() => channels[0].onmessage?.(junk)).not.toThrow();
    expect(clients[0].received).toEqual([junk]);
  });

  it("does not let a stale unregister silence a newer listener", async () => {
    // The editor remounts (a project switch, a hot reload) and registers again
    // before the old one's cleanup runs. Clearing the slot then would leave the
    // live editor never hearing a refresh, and nothing would say so.
    const m = await freshModule();
    await m.ensureLspFor("/proj/rf5/a.ts", "/proj/rf5");
    const seen: string[] = [];
    const offOld = m.setSemanticRefreshListener(() => void seen.push("old"));
    m.setSemanticRefreshListener(() => void seen.push("new"));
    offOld();
    channels[0].onmessage?.(refresh(1));
    expect(seen).toEqual(["new"]);
  });

  it("still answers the server when nothing is listening", async () => {
    // Between teardown and the next mount. The reply is owed regardless: an
    // unanswered request leaves the server waiting on its own timeout.
    const m = await freshModule();
    await m.ensureLspFor("/proj/rf6/a.ts", "/proj/rf6");
    channels[0].onmessage?.(refresh(3));
    expect(JSON.parse(sends[0].message).id).toBe(3);
  });
});

describe("lspTargetFor", () => {
  it("hands back the session that answers for the file", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/t/a.ts", "/proj/t");
    expect(m.lspTargetFor("/proj/t/a.ts")?.root).toBe("/proj/t");
  });

  it("is null for a file no server claims", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/t2/a.ts", "/proj/t2");
    expect(m.lspTargetFor("/proj/t2/notes.txt")).toBeNull();
    expect(m.lspTargetFor("/elsewhere/a.ts")).toBeNull();
  });

  it("picks the nearest root, the same rule the plugin uses", async () => {
    // Otherwise a question about `packages/a` is answered by the repo-root
    // server, out of the wrong compiler config.
    const m = await freshModule();
    resolveRoot = (a) => (a.filePath.includes("/packages/a/") ? "/proj/u/packages/a" : "/proj/u");
    await m.ensureLspFor("/proj/u/index.ts", "/proj/u");
    await m.ensureLspFor("/proj/u/packages/a/index.ts", "/proj/u");
    expect(m.lspTargetFor("/proj/u/packages/a/index.ts")?.root).toBe("/proj/u/packages/a");
  });

  it("reports a provider only once the server has advertised it", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/v/a.ts", "/proj/v");
    const target = m.lspTargetFor("/proj/v/a.ts")!;
    // Null capabilities is the state between `lsp_start` and the initialize
    // reply; claiming a provider then is what draws a MethodNotFound.
    expect(target.supports("documentSymbolProvider")).toBe(false);
    clients[0].serverCapabilities = { documentSymbolProvider: true };
    expect(target.supports("documentSymbolProvider")).toBe(true);
    expect(target.supports("workspaceSymbolProvider")).toBe(false);
  });

  it("hands back what a capability carries, not just whether it is there", async () => {
    // `semanticTokensProvider` ships the legend naming what each token index
    // means; a token stream read without it is a list of integers, so a boolean
    // is not enough for this one.
    const m = await freshModule();
    await m.ensureLspFor("/proj/v2/a.ts", "/proj/v2");
    const target = m.lspTargetFor("/proj/v2/a.ts")!;
    expect(target.capability("semanticTokensProvider")).toBeUndefined();
    const legend = { tokenTypes: ["parameter"], tokenModifiers: [] };
    clients[0].serverCapabilities = { semanticTokensProvider: { legend, full: true } };
    expect(target.capability("semanticTokensProvider")).toEqual({ legend, full: true });
    expect(target.capability("documentSymbolProvider")).toBeUndefined();
  });

  it("passes a request and a sync straight through to its client", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/w/a.ts", "/proj/w");
    const target = m.lspTargetFor("/proj/w/a.ts")!;
    target.sync();
    await target.request("textDocument/documentSymbol", { textDocument: { uri: "file:///proj/w/a.ts" } });
    expect(clients[0].syncs).toBe(1);
    expect(clients[0].requests[0].method).toBe("textDocument/documentSymbol");
  });
});

describe("lspTargets", () => {
  it("lists every live session, because a workspace query has to ask them all", async () => {
    const m = await freshModule();
    resolveRoot = (a) => (a.filePath.includes("/packages/a/") ? "/proj/x/packages/a" : "/proj/x");
    await m.ensureLspFor("/proj/x/index.ts", "/proj/x");
    await m.ensureLspFor("/proj/x/packages/a/index.ts", "/proj/x");
    expect(m.lspTargets().map((t) => t.root).sort()).toEqual(["/proj/x", "/proj/x/packages/a"]);
  });

  it("is empty once the project is torn down", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/y/a.ts", "/proj/y");
    await m.stopAllLsp();
    expect(m.lspTargets()).toEqual([]);
  });
});

describe("project switch", () => {
  it("stops every server and drops every client", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/t/a.ts", "/proj/t");
    await m.ensureLspFor("/proj/t/main.rs", "/proj/t");
    await m.stopAllLsp();

    expect(stopped).toEqual(["all"]);
    expect(m.lspPluginFor("/proj/t/a.ts")).toEqual([]);
    expect(m.lspPluginFor("/proj/t/main.rs")).toEqual([]);
  });

  it("never starts a server for a project already switched away from", async () => {
    const m = await freshModule();
    // The open is requested, then the user switches projects before the start
    // gets its turn. Starting now would spawn a server nothing will ever use.
    const inflight = m.ensureLspFor("/proj/x/a.ts", "/proj/x");
    await m.stopAllLsp();
    await inflight;

    expect(started).toEqual([]);
    expect(clientConfigs).toEqual([]);
    expect(m.lspPluginFor("/proj/x/a.ts")).toEqual([]);
  });

  it("discards a start that lands after a teardown, and stops the server it made", async () => {
    const m = await freshModule();
    // Hold lsp_start open so the teardown lands while it is genuinely in
    // flight, which is the case no pre-check can catch.
    let release!: () => void;
    holdStart = new Promise<void>((r) => (release = r));

    const inflight = m.ensureLspFor("/proj/y/a.ts", "/proj/y");
    // Let the chain reach the invoke before switching away.
    while (started.length === 0) await Promise.resolve();

    await m.stopAllLsp();
    release();
    await inflight;

    // The late arrival must not register a client for the project that was
    // just torn down, or buffers get a plugin for a server already killed.
    expect(m.lspPluginFor("/proj/y/a.ts")).toEqual([]);
    expect(clientConfigs).toEqual([]);
    // And the server it did bring up is stopped by handle rather than leaked,
    // since lsp_stop_all had already swept past it.
    expect(stopped).toEqual(["all", "typescript"]);
  });

  it("leaves no stale client: the next project starts fresh", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/old/a.ts", "/old");
    await m.stopAllLsp();
    await m.ensureLspFor("/new/a.ts", "/new");

    expect(started.map((s) => s.projectPath)).toEqual(["/old", "/new"]);
    // The old root answers for nothing now.
    expect(m.lspPluginFor("/old/a.ts")).toEqual([]);
    expect(m.lspPluginFor("/new/a.ts")).not.toEqual([]);
  });
});

describe("a server that cannot start", () => {
  it("leaves the file editable with no plugin rather than throwing", async () => {
    const m = await freshModule();
    startFails = true;
    try {
      // A registered server whose binary is missing: the backend rejects, and
      // the editor's job is to carry on. The file opens and edits exactly as a
      // file of an unsupported language does.
      await expect(m.ensureLspFor("/proj/v/main.rs", "/proj/v")).resolves.toBeUndefined();
      expect(m.lspPluginFor("/proj/v/main.rs")).toEqual([]);
      expect(clientConfigs).toEqual([]);
    } finally {
      startFails = false;
    }
  });

  it("does not poison later starts of a server that is present", async () => {
    const m = await freshModule();
    startFails = true;
    await m.ensureLspFor("/proj/w/main.rs", "/proj/w");
    startFails = false;
    await m.ensureLspFor("/proj/w/a.ts", "/proj/w");
    // The failed start queued on the rust chain; typescript is unaffected, and
    // a per-server chain that swallowed the rejection keeps working.
    expect(m.lspPluginFor("/proj/w/a.ts")).not.toEqual([]);
  });
});

// What makes a cross-file operation possible at all: the client is given a
// workspace that can reach a file nobody opened. The library's own workspace
// knows only files with a live view, so without this every jump into another
// file is a silent no-op.
describe("the workspace each client is given", () => {
  type Ws = {
    requestFile: (uri: string) => Promise<{ doc: { toString(): string } } | null>;
    displayFile: (uri: string) => Promise<unknown>;
    syncFiles: () => readonly { file: { doc: { toString(): string } } }[];
    disconnected: () => void;
  };

  it("materialises a file nobody opened, from disk", async () => {
    const m = await freshModule();
    disk["/proj/x/dep.ts"] = "export const dep = 1";
    await m.ensureLspFor("/proj/x/a.ts", "/proj/x");

    const ws = clients[0].workspace as Ws;
    const file = await ws.requestFile("file:///proj/x/dep.ts");
    expect(file?.doc.toString()).toBe("export const dep = 1");
  });

  it("prefers an unsaved background buffer to what is on disk", async () => {
    // The dirty-background-tab case, end to end through the real dependency
    // wiring: the buffer text exists only inside the editor component, and
    // reading the file instead would answer with a copy the user cannot see.
    const m = await freshModule();
    const { setBufferAccess } = await import("./liveBuffers");
    disk["/proj/x/dirty.ts"] = "on disk";
    const off = setBufferAccess({
      textOf: (p: string) => (p === "/proj/x/dirty.ts" ? "unsaved edits" : null),
      isDirty: () => true,
      adopt: () => {},
    });
    try {
      await m.ensureLspFor("/proj/x/a.ts", "/proj/x");
      const ws = clients[0].workspace as Ws;
      const file = await ws.requestFile("file:///proj/x/dirty.ts");
      expect(file?.doc.toString()).toBe("unsaved edits");
    } finally {
      off();
    }
  });

  it("hears about a file that changed underneath a snapshot", async () => {
    const m = await freshModule();
    disk["/proj/x/dep.ts"] = "export const dep = 1";
    await m.ensureLspFor("/proj/x/a.ts", "/proj/x");
    const ws = clients[0].workspace as Ws;
    await ws.requestFile("file:///proj/x/dep.ts");

    disk["/proj/x/dep.ts"] = "export const dep = 2";
    m.notifyLspFileChanged("/proj/x/dep.ts");
    await Promise.resolve(); // the notify is fire-and-forget
    await Promise.resolve();

    const [update] = ws.syncFiles();
    expect(update.file.doc.toString()).toBe("export const dep = 2");
  });

  it("asks the app to open a file the server wants shown", async () => {
    const m = await freshModule();
    const { OPEN_IN_EDITOR } = await import("../../utils/events");
    await m.ensureLspFor("/proj/y/a.ts", "/proj/y");
    const ws = clients[0].workspace as Ws;

    // `emitWith` dispatches on `window`, which this project's unit environment
    // does not have; an EventTarget is all it actually needs.
    const opened: string[] = [];
    const bus = new EventTarget();
    bus.addEventListener(OPEN_IN_EDITOR, (e) =>
      opened.push((e as CustomEvent<{ path: string }>).detail.path),
    );
    vi.stubGlobal("window", bus);
    try {
      const pending = ws.displayFile("file:///proj/y/dep.ts");
      expect(opened).toEqual(["/proj/y/dep.ts"]);
      // Settle it rather than leaving its timeout running past the test.
      ws.disconnected();
      expect(await pending).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("an empty registry", () => {
  it("leaves every file server-less without throwing", async () => {
    const real = registry;
    registry = [];
    try {
      const m = await freshModule();
      await m.ensureLspFor("/proj/u/a.ts", "/proj/u");
      await m.ensureLspFor("/proj/u/main.py", "/proj/u");
      // Both open and edit normally; neither gets a plugin, and nothing threw.
      expect(m.lspPluginFor("/proj/u/a.ts")).toEqual([]);
      expect(m.lspPluginFor("/proj/u/main.py")).toEqual([]);
      expect(started).toEqual([]);
    } finally {
      registry = real;
    }
  });
});

// The same question `lspPluginFor` answers, asked without building anything,
// because the fallback completion needs to know whether to stay out of the way.
// It is about *now*, not about the file type: a buffer opened before the client
// exists is unclaimed, and gains a claim when the client arrives.
describe("claimedByLsp", () => {
  it("says no before the client is up, even for a file the server would take", async () => {
    vi.resetModules();
    const fresh = await import("./lspClient");
    expect(fresh.claimedByLsp("/proj/y/src/a.ts")).toBe(false);
  });

  it("says yes for a TS file under the active root", async () => {
    await ensureLsp("/proj/j");
    expect(claimedByLsp("/proj/j/src/a.ts")).toBe(true);
  });

  it("says no for a file the server does not handle, and for one outside the root", async () => {
    await ensureLsp("/proj/k");
    expect(claimedByLsp("/proj/k/notes.txt")).toBe(false);
    expect(claimedByLsp("/elsewhere/notes/a.ts")).toBe(false);
  });

  it("agrees with what `lspPluginFor` actually attaches", async () => {
    // The two answers are one answer; a drift between them would put word
    // completion in a buffer that also has the server's, or in neither.
    await ensureLsp("/proj/l");
    for (const path of ["/proj/l/src/a.ts", "/proj/l/notes.txt", "/elsewhere/a.ts"]) {
      const attached = lspPluginFor(path);
      expect(claimedByLsp(path), path).toBe(!Array.isArray(attached));
    }
  });
});
