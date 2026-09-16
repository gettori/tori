// Arming a breakpoint on save, against the real save path.
//
// `debugBreakpoints.ts` decides that a pending breakpoint arms on the clean edge
// and is unit-tested there. What no unit test can see is the *order* inside a
// ⌘S: organize-on-save and format-on-save both rewrite the file before the bytes
// are written, and a breakpoint armed from the buffer as it was when you pressed
// save would name a line the formatter has since moved. The claim under test is
// that the moved lines are reported before the file is reported clean, so what
// is armed is the file that is now on disk.
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
// Line 3 is the one with a breakpoint on it. Organizing adds an import above,
// so on disk it becomes line 4.
const DISK = "import { b } from './b'\nconst x = 1\nconst y = 2\n";
const ORGANIZED = "import { a } from './a'\nimport { b } from './b'\nconst x = 1\nconst y = 2\n";

let written: { path: string; contents: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "fs_read_file":
        return Promise.resolve(DISK);
      case "fs_write_file":
        written.push({ path: args.path as string, contents: args.contents as string });
        return Promise.resolve(null);
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
      const msg = JSON.parse(message) as { id?: number; method?: string };
      if (msg.id === undefined) return;
      const result =
        msg.method === "initialize"
          ? { capabilities: { codeActionProvider: { codeActionKinds: ["source.organizeImports"] } } }
          : msg.method === "textDocument/codeAction"
            ? [organizeAction()]
            : null;
      receive?.(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    },
    subscribe: (h) => (receive = h),
    unsubscribe: () => {},
  };
}

vi.mock("./lspClient", async () => {
  const { pathToUri: toUri } = await import("./toriWorkspace");
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
const { pathToUri } = await import("./toriWorkspace");
const { emit, onWith, EDITOR_SAVE, EDITOR_FILE_SAVED } = await import("../../utils/events");
const { saveSettings, DEFAULT_SETTINGS } = await import("../Settings/settingsStore");

/** An organize-imports answer that adds a line, so every line below it moves. */
const organizeAction = () => ({
  title: "Organize imports",
  kind: "source.organizeImports",
  edit: {
    changes: {
      [pathToUri(FILE)]: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 23 } },
          newText: "import { a } from './a'\nimport { b } from './b'",
        },
      ],
    },
  },
});

let mounted: ReturnType<typeof render> | null = null;
/** Everything the pane was told, in order. The order is the whole test. */
let told: string[] = [];

async function mount() {
  client = new LSPClient({
    rootUri: pathToUri(REPO),
    extensions: [...languageServerExtensions()],
  }).connect(fakeServer());

  mounted = render(() => (
    <CodeEditor
      activePath={FILE}
      openPaths={[FILE]}
      projectRoot={REPO}
      goto={null}
      onDirty={(_p, d) => told.push(`clean:${!d}`)}
      breakpoints={[{ line: 3, state: "armed" }]}
      onBreakpointsMoved={(_p, lines) => told.push(`moved:${lines.join(",")}`)}
      selected={null}
    />
  ));
  await waitFor(() => expect(told.length).toBeGreaterThan(0));
  await client.initializing;
}

beforeEach(async () => {
  written = [];
  told = [];
  localStorage.clear();
  await saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, organizeImportsOnSave: true },
  });
});

afterEach(async () => {
  mounted?.unmount();
  mounted = null;
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
});

describe("a save that rewrites the file", () => {
  // The chat composer mirrors a scratch draft off this report, so it has to
  // carry the bytes as written, after the rewrite, and fire exactly once.
  it("reports the saved file once, with the bytes that landed on disk", async () => {
    await mount();
    const saved: { path: string; contents: string }[] = [];
    const off = onWith<{ path: string; contents: string }>(EDITOR_FILE_SAVED, (d) => saved.push(d));

    emit(EDITOR_SAVE);
    await waitFor(() => expect(written).toHaveLength(1));
    expect(saved).toEqual([{ path: FILE, contents: ORGANIZED }]);
    off();
  });

  it("reports the moved line before it reports the file clean", async () => {
    await mount();

    emit(EDITOR_SAVE);
    await waitFor(() => expect(written).toHaveLength(1));
    // The rewrite really happened, so the ordering below is about something.
    expect(written[0].contents).toBe(ORGANIZED);

    const moved = told.lastIndexOf("moved:4");
    const clean = told.lastIndexOf("clean:true");
    expect(moved, "the formatter's edit moved the breakpoint to line 4").toBeGreaterThanOrEqual(0);
    // The clean edge is what arms a pending breakpoint. Arriving after the
    // formatter's edit has been reported is what makes the armed line the one in
    // the file that was just written, rather than the one you clicked.
    expect(clean).toBeGreaterThan(moved);
  });
});
