// Organize-on-save, wired: the setting reaches the save path, the server is
// asked for the right kind, and what lands on disk is what the server sent back.
//
// The decisions themselves are unit-tested in `organizeOnSave.test.ts`. What is
// left to get wrong is everything between them and a ⌘S, which is exactly the
// seam a unit test cannot see: which deps get built, in what order they run
// relative to the formatter, and whether the buffer the formatter is handed is
// the one organizing just replaced.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";

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
            ? (organizeEdit ? [organizeEdit] : [])
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
  const { pathToUri: toUri } = await import("./swayWorkspace");
  return {
    claimedByLsp: () => true,
    ensureLspFor: () => Promise.resolve(),
    lspPluginFor: (path: string) => client.plugin(toUri(path), "typescript"),
    lspTargetFor: () => ({
      root: REPO,
      ready: client.initializing.then(
        () => {},
        () => {},
      ),
      supports: (cap: string) => !!(client.serverCapabilities as Record<string, unknown>)?.[cap],
      capability: (name: string) => (client.serverCapabilities as Record<string, unknown>)?.[name],
      sync: () => client.sync(),
      request: (method: string, params: unknown) => client.request(method, params),
    }),
    lspTargets: () => [],
    executeServerCommand: () => Promise.resolve(null),
    notifyLspFileChanged: () => {},
    onLspChange: () => () => {},
    setSemanticRefreshListener: () => () => {},
    setCodeLensRefreshListener: () => () => {},
    stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve(),
  };
});

const { default: CodeEditor } = await import("./CodeEditor");
const { pathToUri } = await import("./swayWorkspace");
const { emit, EDITOR_SAVE } = await import("../../utils/events");
const { saveSettings, DEFAULT_SETTINGS } = await import("../Settings/settingsStore");

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
    expect(asked.some((a) => a.method === "textDocument/codeAction"), "a save nobody opted into is free").toBe(
      false,
    );
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
    expect((request.params as { context: { only: string[] } }).context.only).toEqual([
      "source.organizeImports",
    ]);
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
