// ⌘⌥A, end to end: the command's event reaches the pane, the pane asks the
// server through a real `LSPClient`, and what comes back becomes a menu.
//
// Everything below the event is real - the library's plugin, its request
// plumbing, Sway's capability blocks and normalising - because each of the
// pieces is already unit-tested apart and what is left to get wrong is the
// wiring between them. Only the transport is fake, and it answers the way a
// server does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const FILE = `${REPO}/a.ts`;

/** What the fake server offers, per test. */
let offered: unknown[] = [];
let provider: unknown = true;
let asked: { method: string; params: unknown }[] = [];
/** With this on, code-action replies are held until a test releases them, so
 *  two requests can be in flight at once. */
let hold = false;
let held: (() => void)[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "fs_read_file":
        return Promise.resolve("const before = 1;\nconst after = 2;\n");
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

// A server on the other end of a promise-free transport: every reply is sent
// back synchronously, which is what keeps these tests from having to know how
// many microtasks the library takes.
function fakeServer() {
  let receive: ((msg: string) => void) | null = null;
  const transport: Transport = {
    send: (message) => {
      const msg = JSON.parse(message) as { id?: number; method?: string; params?: unknown };
      if (msg.id === undefined) return; // a notification wants no answer
      asked.push({ method: msg.method!, params: msg.params });
      const result =
        msg.method === "initialize"
          ? { capabilities: { codeActionProvider: provider } }
          : msg.method === "textDocument/codeAction"
            ? offered
            : null;
      const answer = () => receive?.(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      if (hold && msg.method === "textDocument/codeAction") held.push(answer);
      else answer();
    },
    subscribe: (h) => (receive = h),
    unsubscribe: () => {},
  };
  return transport;
}

const { pathToUri } = await import("./swayWorkspace");

let client: LSPClient;

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
    stopAllLsp: () => Promise.resolve(),
  };
});

const { default: CodeEditor } = await import("./CodeEditor");
const { emit, onWith, EDITOR_LSP_CODE_ACTION, TOAST } = await import("../../utils/events");
const { clearCodeActions, refreshCodeActions } = await import("./lspCodeActions");
const { CODE_ACTION_GUTTER_CLASS, CODE_ACTION_MARKER_CLASS } = await import("./codeActionGutter");

let mounted: ReturnType<typeof render> | null = null;
// The toast host is App's, not the pane's, so what the pane says is read off
// the event rather than the DOM.
let toasts: string[] = [];
let offToast: () => void = () => {};

async function mount() {
  // Connected here rather than in `beforeEach`: `connect` sends `initialize`
  // and the fake answers it on the spot, so a client built before the test body
  // set `provider` would be answered with the previous case's capabilities.
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
  // The plugin's `initialize` has to be answered before anything asks whether
  // the server does code actions.
  await client.initializing;
}

const openMenu = async () => {
  emit(EDITOR_LSP_CODE_ACTION);
  await waitFor(() => expect(asked.some((a) => a.method === "textDocument/codeAction")).toBe(true));
};

beforeEach(() => {
  offered = [];
  provider = true;
  asked = [];
  hold = false;
  held = [];
  clearCodeActions();
  toasts = [];
  offToast = onWith<{ message: string }>(TOAST, (t) => toasts.push(t.message));
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  offToast();
  clearCodeActions();
});

describe("the code-action menu", () => {
  it("opens on the command's event, listing what the server offered", async () => {
    offered = [
      { title: "Add import from './b'", kind: "quickfix" },
      { title: "Extract to function", kind: "refactor.extract" },
    ];
    await mount();

    await openMenu();

    await waitFor(() => expect(screen.getByText("Add import from './b'")).toBeTruthy());
    expect(screen.getByText("Extract to function")).toBeTruthy();
  });

  it("opens exactly one menu for one press", async () => {
    // The pane listens for the command's event and the editor's own keymap
    // binds ⌥⏎. If ⌘⌥A were also in that keymap, one press would open two.
    offered = [{ title: "Add import", kind: "quickfix" }];
    await mount();

    await openMenu();

    await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(1));
  });

  it("does not claim ⌘⌥A in the editor's own keymap", async () => {
    // The binding is a window-scope command, and the editor preventDefaulting
    // it would be the second half of a double-open. Here nothing dispatches the
    // command, so a menu appearing at all would mean the keymap took the chord.
    offered = [{ title: "Add import", kind: "quickfix" }];
    await mount();

    const content = mounted!.container.querySelector(".cm-content")!;
    fireEvent.keyDown(content, { key: "a", code: "KeyA", metaKey: true, altKey: true });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on ⌥⏎, the chord every other editor uses", async () => {
    offered = [{ title: "Add import", kind: "quickfix" }];
    await mount();

    const content = mounted!.container.querySelector(".cm-content")!;
    fireEvent.keyDown(content, { key: "Enter", code: "Enter", altKey: true });

    await waitFor(() => expect(screen.getByText("Add import")).toBeTruthy());
  });

  it("says so when the server looked and offered nothing", async () => {
    // Silence here would read as a broken key rather than a clean file.
    offered = [];
    await mount();

    await openMenu();

    await waitFor(() => expect(toasts).toContain("No code actions here."));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("asks about the caret, with the file's own uri", async () => {
    offered = [{ title: "x", kind: "quickfix" }];
    await mount();

    await openMenu();

    const params = asked.find((a) => a.method === "textDocument/codeAction")!.params as {
      textDocument: { uri: string };
      range: { start: { line: number } };
      context: { triggerKind: number };
    };
    expect(params.textDocument.uri).toBe(pathToUri(FILE));
    expect(params.range.start.line).toBe(0);
    expect(params.context.triggerKind).toBe(1);
  });
});

describe("a press racing the pane's own background refresh", () => {
  it("still opens the menu when the refresh answers the same question first", async () => {
    // The pane re-asks on a debounce as the caret moves, so a press made in the
    // same moment produces two requests about one caret. The background one can
    // win the latest-wins token and publish first - and since it asked the
    // *same* question, its answer is this press's answer too. Comparing the
    // published range by identity rather than by value would drop the keystroke
    // here and say nothing at all, which is indistinguishable from a dead key.
    offered = [{ title: "Add import", kind: "quickfix" }];
    await mount();
    hold = true;

    emit(EDITOR_LSP_CODE_ACTION);
    await waitFor(() => expect(held).toHaveLength(1));
    // The pane's own refresh, asking about the very same caret.
    void refreshCodeActions(FILE, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    await waitFor(() => expect(held).toHaveLength(2));

    held[1]();
    held[0]();

    await waitFor(() => expect(screen.getByText("Add import")).toBeTruthy());
  });
});

describe("the lightbulb in the gutter", () => {
  const bulbs = () => mounted!.container.querySelectorAll(`.${CODE_ACTION_MARKER_CLASS}`);

  it("appears once the server has said there is something here", async () => {
    offered = [{ title: "Add import", kind: "quickfix" }];
    await mount();
    expect(bulbs(), "nothing before an answer").toHaveLength(0);

    await openMenu();

    await waitFor(() => expect(bulbs()).toHaveLength(1));
  });

  it("stays away when the server looked and offered nothing", async () => {
    offered = [];
    await mount();

    await openMenu();

    await new Promise((r) => setTimeout(r, 0));
    expect(bulbs()).toHaveLength(0);
  });
});

describe("a server that does no code actions", () => {
  it("asks nothing and shows nothing, rather than drawing a MethodNotFound", async () => {
    // The whole surface is gated on the advertised provider: a server that
    // never claimed `codeActionProvider` is one this must not talk to.
    provider = undefined;
    await mount();

    emit(EDITOR_LSP_CODE_ACTION);
    await new Promise((r) => setTimeout(r, 0));

    expect(asked.some((a) => a.method === "textDocument/codeAction")).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(toasts, "not an empty answer, no answer").toEqual([]);
  });

  it("reserves no gutter column, so every ordinary buffer is unchanged", async () => {
    // Not a styling preference: this gutter is in `commonExtensions`, so it is
    // in every buffer in the app. A column held open for it would be a stripe
    // of empty space in files no language server has ever looked at.
    provider = undefined;
    await mount();

    expect(mounted!.container.querySelectorAll(`.${CODE_ACTION_MARKER_CLASS}`)).toHaveLength(0);
    // The gutter itself exists (it is a static extension); what must not exist
    // is anything in it holding width.
    const column = mounted!.container.querySelector(`.${CODE_ACTION_GUTTER_CLASS}`);
    expect(column?.querySelector(`.${CODE_ACTION_MARKER_CLASS}`)).toBeFalsy();
  });
});
