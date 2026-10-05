// Organize-on-save and fix-all-on-save, wired: the setting reaches the save
// path, the server is asked for the right kind, and what lands on disk is what
// the server sent back.
//
// The decisions themselves are unit-tested in `organizeOnSave.test.ts`. What is
// left to get wrong is everything between them and a ⌘S, which is exactly the
// seam a unit test cannot see: which deps get built, in what order they run
// relative to the formatter, and whether the buffer the formatter is handed is
// the one organizing just replaced.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, waitFor } from "@solidjs/testing-library";
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import { EditorView } from "@codemirror/view";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const FILE = `${REPO}/a.ts`;
const DISK = "import { b } from './b'\nimport { a } from './a'\n";
const SORTED = "import { a } from './a'\nimport { b } from './b'\n";

let asked: { method: string; params: unknown }[] = [];
let written: { path: string; contents: string }[] = [];
/** What the fake server answers a `source.organizeImports` request with. */
let organizeEdit: unknown = null;
/** Held replies, for the case where the server never answers. */
let hold = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "fs_read_file":
        return Promise.resolve(DISK);
      case "fs_write_file":
        written.push({ path: args.path as string, contents: args.contents as string });
        return Promise.resolve(null);
      // The backend echoes what it wrote, and `saveSettings` puts that echo in
      // the store. Returning null here would blank it instead.
      case "set_settings":
        return Promise.resolve(args.settings);
      case "git_status":
      case "git_diff_file":
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

let client: LSPClient;

/** Servers running beside the file's own, as `lspTargetsFor` hands them out. */
let secondaries: unknown[] = [];

function fakeServer(): Transport {
  let receive: ((msg: string) => void) | null = null;
  return {
    send: (message) => {
      const msg = JSON.parse(message) as { id?: number; method?: string; params?: unknown };
      if (msg.id === undefined) return;
      asked.push({ method: msg.method!, params: msg.params });
      const result =
        msg.method === "initialize"
          ? { capabilities: { codeActionProvider: { codeActionKinds: ["source.organizeImports"] } } }
          : msg.method === "textDocument/codeAction"
            ? organizeEdit
              ? [organizeEdit]
              : []
            : null;
      const answer = () => receive?.(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      if (hold && msg.method === "textDocument/codeAction") return;
      answer();
    },
    subscribe: (h) => (receive = h),
    unsubscribe: () => {},
  };
}

vi.mock("./lspClient", async () => {
  const { pathToUri: toUri } = await import("./toriWorkspace");
  const target = () => ({
    root: REPO,
    serverId: "typescript",
    ready: client.initializing.then(
      () => {},
      () => {},
    ),
    supports: (cap: string) => !!(client.serverCapabilities as Record<string, unknown>)?.[cap],
    capability: (name: string) => (client.serverCapabilities as Record<string, unknown>)?.[name],
    sync: () => client.sync(),
    request: (method: string, params: unknown) => client.request(method, params),
  });
  return {
    claimedByLsp: () => true,
    ensureLspFor: () => Promise.resolve(),
    lspPluginFor: (path: string) => client.plugin(toUri(path), "typescript"),
    lspTargetFor: target,
    lspTargetsFor: () => [target(), ...secondaries],
    lspTargets: () => [],
    executeServerCommand: () => Promise.resolve(null),
    notifyLspFileChanged: () => {},
    onLspChange: () => () => {},
    setSemanticRefreshListener: () => () => {},
    setCodeLensRefreshListener: () => () => {},
    stopAllLsp: () => Promise.resolve(),
    stopEvictedLspRoots: () => Promise.resolve(),
  };
});

const { default: CodeEditor } = await import("./CodeEditor");
const { pathToUri } = await import("./toriWorkspace");
const { emit, EDITOR_SAVE } = await import("../../utils/events");
const { saveSettings, DEFAULT_SETTINGS: STORE_DEFAULTS } = await import("../Settings/settingsStore");
// Copied before any save: the store proxies its defaults object, so a save
// rewrites it and a reset from it would carry the last test's settings over.
const DEFAULT_SETTINGS = structuredClone(STORE_DEFAULTS);

/** The whole-file replacement a server answers organize-imports with. */
const sortedAction = () => ({
  title: "Organize imports",
  kind: "source.organizeImports",
  edit: {
    changes: {
      [pathToUri(FILE)]: [
        { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 23 } }, newText: SORTED.trimEnd() },
      ],
    },
  },
});

let mounted: ReturnType<typeof render> | null = null;

async function mount() {
  client = new LSPClient({
    rootUri: pathToUri(REPO),
    extensions: [...languageServerExtensions()],
  }).connect(fakeServer());

  const dirty: string[] = [];
  mounted = render(() => (
    <CodeEditor
      activePath={FILE}
      openPaths={[FILE]}
      projectRoot={REPO}
      goto={null}
      onDirty={(p) => dirty.push(p)}
      selected={null}
    />
  ));
  await waitFor(() => expect(dirty.length).toBeGreaterThan(0));
  await client.initializing;
}

const setOrganizeOnSave = (on: boolean) =>
  saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, organizeImportsOnSave: on },
  });

beforeEach(async () => {
  secondaries = [];
  asked = [];
  written = [];
  organizeEdit = sortedAction();
  hold = false;
  localStorage.clear();
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
});

afterEach(async () => {
  mounted?.unmount();
  mounted = null;
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
});

describe("with the setting off", () => {
  it("asks the server nothing and writes what the buffer held", async () => {
    await mount();

    emit(EDITOR_SAVE);

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].contents).toBe(DISK);
    expect(
      asked.some((a) => a.method === "textDocument/codeAction"),
      "a save nobody opted into is free",
    ).toBe(false);
  });
});

describe("with the setting on", () => {
  it("writes the organized text, having asked for that kind by name", async () => {
    await setOrganizeOnSave(true);
    await mount();

    emit(EDITOR_SAVE);

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].contents).toBe(SORTED);

    const request = asked.find((a) => a.method === "textDocument/codeAction")!;
    expect((request.params as { context: { only: string[] } }).context.only).toEqual(["source.organizeImports"]);
  });

  it("puts the organized text in the buffer too, so disk and screen agree", async () => {
    await setOrganizeOnSave(true);
    await mount();

    emit(EDITOR_SAVE);

    await waitFor(() => expect(written).toHaveLength(1));
    expect(mounted!.container.querySelector(".cm-content")?.textContent).toContain("from './a'import { b }");
  });

  it("still saves when the server offers no organize-imports for the file", async () => {
    organizeEdit = null;
    await setOrganizeOnSave(true);
    await mount();

    emit(EDITOR_SAVE);

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].contents).toBe(DISK);
  });

  it("does not hold the save open when the server never answers", async () => {
    // The bound is `organizeOnSave`'s, and this is the wiring that proves a
    // real ⌘S goes through it rather than around it.
    hold = true;
    await setOrganizeOnSave(true);
    await mount();

    emit(EDITOR_SAVE);

    await waitFor(() => expect(written).toHaveLength(1), { timeout: 4000 });
    expect(written[0].contents, "the file the user had, saved on time").toBe(DISK);
  });
});

describe("fix all on save", () => {
  const FIXED = "import { b } from './b';\nimport { a } from './a';\n";
  const semi = (line: number) => ({
    range: { start: { line, character: 23 }, end: { line, character: 23 } },
    newText: ";",
  });

  /** An ESLint beside the primary whose fix-all adds the missing semicolons, and
   *  which answers only when `release` is called if `held`. */
  function eslint(held = false) {
    const asked: { method: string; params: unknown }[] = [];
    let answer: (() => void) | null = null;
    const reply = [
      {
        title: "Fix all fixable ESLint issues",
        kind: "source.fixAll.eslint",
        edit: { documentChanges: [{ textDocument: { uri: pathToUri(FILE), version: 0 }, edits: [semi(0), semi(1)] }] },
      },
    ];
    return {
      asked,
      release: () => answer?.(),
      root: REPO,
      serverId: "eslint",
      ready: Promise.resolve(),
      supports: (cap: string) => cap === "codeActionProvider",
      capability: () => ({ codeActionKinds: ["quickfix", "source.fixAll.eslint"] }),
      sync: () => {},
      request: (method: string, params: unknown) => {
        asked.push({ method, params });
        const result = method === "textDocument/codeAction" ? reply : null;
        return held ? new Promise((r) => (answer = () => r(result))) : Promise.resolve(result);
      },
    };
  }

  const setFixAllOnSave = () =>
    saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, codeActionsOnSave: true },
    });

  it("writes the linter's autofix, having asked every server for source.fixAll", async () => {
    const lint = eslint();
    secondaries = [lint];
    await setFixAllOnSave();
    await mount();

    emit(EDITOR_SAVE);

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].contents).toBe(FIXED);
    for (const log of [asked, lint.asked]) {
      const request = log.find((a) => a.method === "textDocument/codeAction")!;
      expect((request.params as { context: { only: string[] } }).context.only).toEqual(["source.fixAll"]);
    }
  });

  it("drops the fix when the file is typed into while the server answers", async () => {
    const lint = eslint(true);
    secondaries = [lint];
    await setFixAllOnSave();
    await mount();

    emit(EDITOR_SAVE);
    await waitFor(() => expect(lint.asked).toHaveLength(1));
    const view = EditorView.findFromDOM(mounted!.container.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 0, insert: "// x\n" } });
    lint.release();

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].contents, "what is on screen, not the fix").toBe(`// x\n${DISK}`);
  });
});
