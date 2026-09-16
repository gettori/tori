import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    settings: null,
    schema_associations: false,
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
    settings: null,
    schema_associations: false,
    verified_against: null,
    source: "bundled:rust",
  },
];

// What `lsp_schema_associations` answers. Empty is the offline answer, and the
// case that must not put an association-clearing notification on the wire.
let associations: unknown[] = [];

// What `lsp_schema_dir` answers: where this build's own settings schemas are.
// `null` is a build without them, which is the default here so every test that
// predates them sees exactly the wire traffic it was written against.
let schemaDir: string | null = null;

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
    if (cmd === "lsp_schema_associations") return Promise.resolve(associations);
    if (cmd === "lsp_schema_dir") return Promise.resolve(schemaDir);
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
  // `ToriWorkspace` extends this, so it has to be a real constructor even
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
  // The entries carried over from `languageServerExtensions()`, stubbed to
  // markers. What matters here is that each is still handed to the client as a
  // *top-level* entry, since that is the only place an extension's own
  // `clientCapabilities` get merged. Which keys are bound is asserted against
  // the real library in `lspCompletion.test.tsx`.
  hoverTooltips: () => ({ marker: "hoverTooltips" }),
  signatureHelp: () => ({ marker: "signatureHelp" }),
  serverDiagnostics: () => ({ marker: "serverDiagnostics" }),
  jumpToDefinitionKeymap: [{ key: "F12" }],
  findReferencesKeymap: [{ key: "Shift-F12" }],
}));

async function freshModule() {
  vi.resetModules();
  return await import("./lspClient");
}

// What a project switch does: touch the LRU in `lspWarmRoots`, then ask
// `lspClient` to stop whatever fell off. `Editor.tsx` is split the same way and
// for the reason that module's own header gives, so exercising the pair here
// keeps this test on the path the app actually takes. The dynamic import lands
// on the same fresh instance `freshModule` just registered.
async function switchTo(m: Awaited<ReturnType<typeof freshModule>>, projectPath: string) {
  const { touchWarmRoot } = await import("./lspWarmRoots");
  await m.stopEvictedLspRoots(touchWarmRoot(projectPath));
}

beforeEach(() => {
  started.length = 0;
  stopped.length = 0;
  clientConfigs.length = 0;
  clients.length = 0;
  sends.length = 0;
  channels.length = 0;
  disk = {};
  associations = [];
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

  it("agrees with `claimedByLsp`, which is the same question asked cheaply", async () => {
    // The fallback completion reads that predicate to decide whether to stay
    // out of the way. A drift between the two would put scraped words in a
    // buffer that also has the server's list, or in neither.
    const m = await freshModule();
    await m.ensureLspFor("/proj/l/src/a.ts", "/proj/l");
    for (const path of [
      "/proj/l/src/a.ts",
      "/proj/l/notes.txt",
      "/proj/l/main.py",
      "/elsewhere/a.ts",
    ]) {
      expect(m.claimedByLsp(path), path).toBe(!Array.isArray(m.lspPluginFor(path)));
    }
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

describe("workspace-edit capabilities", () => {
  const workspaceBlocks = () =>
    (clientConfigs[0].extensions ?? []).map(
      (e) => (e as { clientCapabilities?: { workspace?: Record<string, unknown> } }).clientCapabilities?.workspace,
    );

  it("advertises applyEdit, documentChanges and executeCommand", async () => {
    // Each one is a promise kept somewhere: the router answers applyEdit,
    // `editsByUri` reads documentChanges, `executeServerCommand` sends the
    // third. A server offers no provider for what the client never asked for.
    const m = await freshModule();
    await m.ensureLspFor("/proj/we/a.ts", "/proj/we");
    const blocks = workspaceBlocks();

    expect(blocks.some((b) => b?.applyEdit === true)).toBe(true);
    expect(blocks.some((b) => (b?.workspaceEdit as { documentChanges?: boolean })?.documentChanges === true)).toBe(true);
    expect(blocks.some((b) => !!b?.executeCommand)).toBe(true);
  });

  it("advertises no resource operations, because it supports none", async () => {
    // Absent means "none of them" to a conformant server, which is how create,
    // rename and delete never arrive in the first place. The applier's refusal
    // is the backstop for servers that send them anyway, not the front line.
    const m = await freshModule();
    await m.ensureLspFor("/proj/we2/a.ts", "/proj/we2");

    const edit = workspaceBlocks().find((b) => b?.workspaceEdit) as
      | { workspaceEdit: Record<string, unknown> }
      | undefined;

    expect(edit?.workspaceEdit).toBeTruthy();
    expect(edit!.workspaceEdit.resourceOperations).toBeUndefined();
  });

  it("keeps the symbol and semantic blocks alongside, not instead of them", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/we3/a.ts", "/proj/we3");
    const blocks = (clientConfigs[0].extensions ?? []).map(
      (e) =>
        (e as { clientCapabilities?: { textDocument?: Record<string, unknown>; workspace?: Record<string, unknown> } })
          .clientCapabilities,
    );

    expect(blocks.some((b) => b?.textDocument?.documentSymbol)).toBe(true);
    expect(blocks.some((b) => b?.textDocument?.semanticTokens)).toBe(true);
    expect(blocks.some((b) => b?.workspace?.applyEdit)).toBe(true);
  });
});

describe("code-action capabilities", () => {
  const codeActionBlock = async (root: string) => {
    const m = await freshModule();
    await m.ensureLspFor(`${root}/a.ts`, root);
    return (clientConfigs[0].extensions ?? [])
      .map(
        (e) =>
          (e as { clientCapabilities?: { textDocument?: { codeAction?: Record<string, unknown> } } })
            .clientCapabilities?.textDocument?.codeAction,
      )
      .find(Boolean);
  };

  it("advertises literal support with the kinds Tori groups by", async () => {
    // Without `codeActionLiteralSupport` a server may answer with bare
    // `Command`s, which carry no kind to group by and no edit to apply.
    const block = await codeActionBlock("/proj/ca");
    const kinds = (block?.codeActionLiteralSupport as { codeActionKind?: { valueSet?: string[] } })
      ?.codeActionKind?.valueSet;

    expect(kinds).toContain("quickfix");
    expect(kinds).toContain("source.organizeImports");
  });

  it("advertises data and resolve support, so an action may arrive without its edit", async () => {
    // The pair is one promise: `data` is the token the server round-trips
    // through `codeAction/resolve`, and `resolveSupport` is what licenses it to
    // leave the expensive half out of the first reply.
    const block = await codeActionBlock("/proj/ca2");

    expect(block?.dataSupport).toBe(true);
    expect(block?.isPreferredSupport).toBe(true);
    expect((block?.resolveSupport as { properties?: string[] })?.properties).toEqual(["edit"]);
  });

  it("puts the raw-diagnostic capture first in the list", async () => {
    // The client stops at the first extension handler returning true, and
    // `serverDiagnostics()` (inside `languageServerExtensions()`) returns true
    // for every publish it renders. Behind it, the capture would only ever see
    // files nobody has open - the opposite of the set a code action is asked
    // about. That the library really behaves that way is checked against the
    // real client in `lspDiagnosticContext.test.ts`; this pins the order here.
    const m = await freshModule();
    await m.ensureLspFor("/proj/ca4/a.ts", "/proj/ca4");
    const first = (clientConfigs[0].extensions ?? [])[0] as {
      notificationHandlers?: Record<string, unknown>;
    };

    expect(first.notificationHandlers?.["textDocument/publishDiagnostics"]).toBeTypeOf("function");
  });

  it("keeps the other capability blocks alongside, not instead of them", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/ca3/a.ts", "/proj/ca3");
    const blocks = (clientConfigs[0].extensions ?? []).map(
      (e) =>
        (e as { clientCapabilities?: { textDocument?: Record<string, unknown>; workspace?: Record<string, unknown> } })
          .clientCapabilities,
    );

    expect(blocks.some((b) => b?.textDocument?.documentSymbol)).toBe(true);
    expect(blocks.some((b) => b?.textDocument?.semanticTokens)).toBe(true);
    expect(blocks.some((b) => b?.workspace?.applyEdit)).toBe(true);
    expect(blocks.some((b) => b?.textDocument?.codeAction)).toBe(true);
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

// The second request on the same seam, added in wave 7 for code lens. Its own
// describe rather than a case in the one above, because what has to be true of
// it is the *pair*: the capability invites the request, and the router is what
// makes the invitation honest.
describe("workspace/codeLens/refresh", () => {
  const refresh = (id: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method: "workspace/codeLens/refresh" });

  it("answers it rather than letting the library reject it", async () => {
    // Tori declares `workspace.codeLens.refreshSupport`, so a -32601 here is
    // the client contradicting its own capabilities. A conformant server reads
    // that as a lie and stops asking, and the lenses would then only ever be as
    // fresh as the next edit to the file they happen to be drawn in - which is
    // exactly the case they cannot detect for themselves, since a reference
    // count changes when a *different* file does.
    const m = await freshModule();
    await m.ensureLspFor("/proj/cl/a.ts", "/proj/cl");
    const roots: string[] = [];
    const off = m.setCodeLensRefreshListener((root: string) => roots.push(root));
    channels[0].onmessage?.(refresh(11));
    expect(JSON.parse(sends[0].message)).toEqual({ jsonrpc: "2.0", id: 11, result: null });
    expect(roots).toEqual(["/proj/cl"]);
    // Never reached the library, which is what would have produced the -32601.
    expect(clients[0].received).toEqual([]);
    off();
  });

  it("names the session that went stale, and does not answer the other one's listener", async () => {
    // The two slots are separate on purpose: a server pushing one kind of
    // refresh is saying nothing about the other, and a shared slot would turn
    // every stale reference count into a re-request for the whole file's
    // colours as well.
    const m = await freshModule();
    await m.ensureLspFor("/proj/cl2/a.ts", "/proj/cl2");
    const lensRoots: string[] = [];
    const semanticRoots: string[] = [];
    m.setCodeLensRefreshListener((root: string) => lensRoots.push(root));
    m.setSemanticRefreshListener((root: string) => semanticRoots.push(root));
    channels[0].onmessage?.(refresh(1));
    expect(lensRoots).toEqual(["/proj/cl2"]);
    expect(semanticRoots).toEqual([]);
  });

  it("still answers the server when nothing is listening", async () => {
    // Between teardown and the next mount. The reply is owed regardless: an
    // unanswered request leaves the server waiting on its own timeout.
    const m = await freshModule();
    await m.ensureLspFor("/proj/cl3/a.ts", "/proj/cl3");
    channels[0].onmessage?.(refresh(4));
    expect(JSON.parse(sends[0].message).id).toBe(4);
  });
});

// The `[settings]` table reaching the server, and the two routes it takes.
// Both exist because the two bundled servers this wave adds disagree about
// which one they read: `vscode-json-languageserver` reads the push,
// `yaml-language-server` answers the push by pulling its configuration back.
describe("server configuration", () => {
  const YAML_SETTINGS = { yaml: { schemaStore: { enable: true } } };

  // The registry is module state, and a describe that swaps it without putting
  // it back leaves every later test asking about servers that no longer exist.
  // One of those spins on `started.length`, so the cost of forgetting is a run
  // that never finishes rather than a failure that names itself.
  const real = registry;
  afterEach(() => {
    registry = real;
  });

  /** Swap the registry for one carrying a configured server. */
  function withServer(extra: Record<string, unknown>) {
    registry = [
      {
        id: "cfg",
        label: "Configured",
        languages: { cfg: "configured" },
        root_markers: [".git"],
        request_timeout_ms: 20000,
        launch: { kind: "path", program: "cfg-server", args: [] },
        initialization_options: null,
        settings: null,
        schema_associations: false,
        verified_against: null,
        source: "bundled:cfg",
        ...extra,
      },
    ];
  }

  /** `configureSession` runs behind `client.initializing`, so the notifications
   *  land a few microtasks after `ensureLspFor` resolves. */
  async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  const sentMethods = () => sends.map((s) => (JSON.parse(s.message) as { method?: string }).method);
  const sentFrame = (method: string) =>
    sends.map((s) => JSON.parse(s.message) as { method?: string; params?: unknown }).find((f) => f.method === method);

  it("pushes the settings once the handshake is done", async () => {
    withServer({ settings: YAML_SETTINGS });
    const m = await freshModule();
    await m.ensureLspFor("/proj/cfg/a.cfg", "/proj/cfg");
    await settle();

    expect(sentFrame("workspace/didChangeConfiguration")?.params).toEqual({ settings: YAML_SETTINGS });
  });

  it("says nothing at all for a server whose config carries no settings", async () => {
    // Most servers. A `didChangeConfiguration` with an empty payload is not the
    // same as silence: it tells a server its configuration just changed to
    // nothing, and rust-analyzer would act on that.
    withServer({});
    const m = await freshModule();
    await m.ensureLspFor("/proj/cfg2/a.cfg", "/proj/cfg2");
    await settle();

    expect(sentMethods()).not.toContain("workspace/didChangeConfiguration");
  });

  it("answers workspace/configuration from that session's own settings", async () => {
    // Positionally, and from the session the request arrived on. The router
    // hands the handle through precisely so this cannot read another server's
    // table, which matters as soon as two configured servers are live.
    withServer({ settings: YAML_SETTINGS });
    const m = await freshModule();
    await m.ensureLspFor("/proj/cfg3/a.cfg", "/proj/cfg3");
    await settle();
    sends.length = 0;

    channels[0].onmessage?.(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "workspace/configuration",
        params: { items: [{ section: "yaml" }, { section: "http" }] },
      }),
    );

    expect(JSON.parse(sends[0].message)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: [YAML_SETTINGS.yaml, null],
    });
    // Answered here, so the library never sees it and never replies -32601.
    expect(clients[0].received).toEqual([]);
  });

  it("answers null sections rather than letting the library refuse the request", async () => {
    // A server with no `[settings]` still owes an answer of the right length.
    // The -32601 the library would send says the client lied about declaring
    // `workspace.configuration`, and a conformant server stops asking.
    withServer({});
    const m = await freshModule();
    await m.ensureLspFor("/proj/cfg4/a.cfg", "/proj/cfg4");
    await settle();
    sends.length = 0;

    channels[0].onmessage?.(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "workspace/configuration",
        params: { items: [{ section: "yaml" }, { section: "files" }] },
      }),
    );

    expect(JSON.parse(sends[0].message).result).toEqual([null, null]);
  });
});

// The SchemaStore catalog reaching the JSON server. It has no catalog logic of
// its own, so a bundled JSON server nobody feeds validates nothing - which
// looks exactly like a server that is not running.
describe("schema associations", () => {
  const real = registry;
  afterEach(() => {
    registry = real;
    schemaDir = null;
  });

  const JSON_SERVER = {
    id: "json",
    label: "JSON",
    languages: { json: "json" },
    root_markers: [".git"],
    request_timeout_ms: 20000,
    launch: { kind: "path", program: "json-server", args: [] },
    initialization_options: null,
    settings: null,
    schema_associations: true,
    verified_against: null,
    source: "bundled:json",
  };

  async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  const frames = () => sends.map((s) => JSON.parse(s.message) as { method?: string; params?: unknown });

  it("sends the catalog to a server whose config asks for it", async () => {
    registry = [JSON_SERVER];
    associations = [{ uri: "https://json.schemastore.org/package.json", fileMatch: ["package.json"] }];
    const m = await freshModule();
    await m.ensureLspFor("/proj/js/a.json", "/proj/js");
    await settle();

    const frame = frames().find((f) => f.method === "json/schemaAssociations");
    // The list as a single positional argument, not as the argument list.
    // `vscode-jsonrpc` spreads a JSON-RPC `params` array across the handler's
    // parameters, so sending the associations bare delivers only the first one
    // and says nothing about the rest. Verified against the real server: bare,
    // a two-entry list produces no diagnostics at all; wrapped, it validates.
    expect(frame?.params).toEqual([associations]);
  });

  it("sends nothing when there is nothing at all to send", async () => {
    // Offline, or a catalog that would not parse, on a build carrying no
    // schemas of its own either. An empty notification is not the same as no
    // notification: it would clear whatever associations the server already
    // had, so degrading has to mean staying quiet.
    registry = [JSON_SERVER];
    associations = [];
    const m = await freshModule();
    await m.ensureLspFor("/proj/js2/a.json", "/proj/js2");
    await settle();

    expect(frames().map((f) => f.method)).not.toContain("json/schemaAssociations");
  });

  it("describes Tori's own settings files even with no catalog at all", async () => {
    // The offline half of the phase, and the reason these are gathered
    // separately from the catalog's: they are files this build ships, so they
    // are there whether or not the network was. Folded into the same list, they
    // would have been dropped by the early return above.
    registry = [JSON_SERVER];
    associations = [];
    schemaDir = "/Applications/Tori.app/Contents/Resources/resources/schemas";
    const m = await freshModule();
    await m.ensureLspFor("/proj/js4/a.json", "/proj/js4");
    await settle();

    const frame = frames().find((f) => f.method === "json/schemaAssociations");
    expect(frame?.params).toEqual([
      [
        {
          uri: `file://${schemaDir}/tori-settings.schema.json`,
          fileMatch: ["**/.config/tori/settings.json"],
        },
        {
          uri: `file://${schemaDir}/tori-workspace-settings.schema.json`,
          fileMatch: ["**/.tori/settings.json"],
        },
      ],
    ]);
  });

  it("puts its own schemas ahead of the catalog's", async () => {
    registry = [JSON_SERVER];
    associations = [{ uri: "https://json.schemastore.org/package.json", fileMatch: ["package.json"] }];
    schemaDir = "/res/schemas";
    const m = await freshModule();
    await m.ensureLspFor("/proj/js5/a.json", "/proj/js5");
    await settle();

    const sent = (frames().find((f) => f.method === "json/schemaAssociations")?.params as unknown[])[0] as {
      uri: string;
    }[];
    expect(sent.map((a) => a.uri)).toEqual([
      "file:///res/schemas/tori-settings.schema.json",
      "file:///res/schemas/tori-workspace-settings.schema.json",
      "https://json.schemastore.org/package.json",
    ]);
  });

  it("never sends it to a server that did not ask", async () => {
    // `json/schemaAssociations` is one server's protocol extension. Every other
    // server would log an unknown-notification warning for it, once per start.
    associations = [{ uri: "https://example.com/s.json", fileMatch: ["a.json"] }];
    const m = await freshModule();
    await m.ensureLspFor("/proj/js3/a.ts", "/proj/js3");
    await settle();

    expect(frames().map((f) => f.method)).not.toContain("json/schemaAssociations");
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

describe("warm roots", () => {
  it("keeps a switched-away project's server, so switching back is a claim, not a start", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/a/a.ts", "/proj/a");
    await switchTo(m, "/proj/b");
    await switchTo(m, "/proj/a");

    // One start ever, and the plugin still attaches after the round trip.
    expect(started.map((s) => s.projectPath)).toEqual(["/proj/a"]);
    expect(stopped).toEqual([]);
    expect(m.lspPluginFor("/proj/a/a.ts")).not.toEqual([]);
  });

  it("stops the project that falls off the warm end, and only that one", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/a/a.ts", "/proj/a");
    await m.ensureLspFor("/proj/b/a.ts", "/proj/b");
    await m.ensureLspFor("/proj/c/a.ts", "/proj/c");
    expect(stopped).toEqual([]);

    // A fourth project evicts the oldest. Its server is stopped by handle and
    // its files answer with nothing; the survivors still claim theirs.
    await m.ensureLspFor("/proj/d/a.ts", "/proj/d");
    expect(stopped).toEqual(["typescript"]);
    expect(m.lspPluginFor("/proj/a/a.ts")).toEqual([]);
    expect(m.lspPluginFor("/proj/b/a.ts")).not.toEqual([]);
    expect(m.lspPluginFor("/proj/d/a.ts")).not.toEqual([]);
  });

  it("re-selecting keeps a project off the eviction end", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/a/a.ts", "/proj/a");
    await m.ensureLspFor("/proj/b/a.ts", "/proj/b");
    await m.ensureLspFor("/proj/c/a.ts", "/proj/c");
    // Coming back to `a` makes `b` the oldest, so the next new project
    // evicts `b` and the flip-flopped pair both stay warm.
    await switchTo(m, "/proj/a");
    await m.ensureLspFor("/proj/d/a.ts", "/proj/d");

    expect(m.lspPluginFor("/proj/a/a.ts")).not.toEqual([]);
    expect(m.lspPluginFor("/proj/b/a.ts")).toEqual([]);
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
      patch: () => "absent" as const,
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
// It is about *now*, not about the file type: a buffer opened before the server
// is up is unclaimed, and gains a claim when the server arrives.
describe("claimedByLsp", () => {
  it("says no before any server is up, even for a file one would take", async () => {
    const m = await freshModule();
    expect(m.claimedByLsp("/proj/y/src/a.ts")).toBe(false);
  });

  it("says yes for a file under a live root whose server claims it", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/j/src/a.ts", "/proj/j");
    expect(m.claimedByLsp("/proj/j/src/a.ts")).toBe(true);
  });

  it("says no for an extension no server handles, and for a file outside every root", async () => {
    const m = await freshModule();
    await m.ensureLspFor("/proj/k/src/a.ts", "/proj/k");
    expect(m.claimedByLsp("/proj/k/notes.txt")).toBe(false);
    expect(m.claimedByLsp("/elsewhere/notes/a.ts")).toBe(false);
  });
});
