import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import PaneView from "../../tabs/PaneView";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import { tab, tabs, closeOf } from "../../test/tabs";
import { installAnimationFrame } from "../../test/frames";

// Starting a run, from the editor's side.
//
// `debugTargets.ts` owns what each config says and is tested on its own. This is
// the part it cannot see: that F5 repeats what this workspace last debugged,
// that a first press opens the picker instead of doing nothing, and that what
// the picker starts reaches `dap_start` with the root the backend resolved.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// The tab strip corrects its visible count in a frame, and these read tabs off
// the row it draws. Without this the row is still seeded empty.
installAnimationFrame();

const REPO = "/space/proj/main";
const PKG = `${REPO}/packages/api`;

type Handle = { server: string; session: string };
type Invoke = { cmd: string; args: Record<string, unknown> };

/** js-debug, plus a second adapter claiming `.rs` so F5 has two to choose
 *  between. */
const REGISTRY = [
  {
    id: "js-debug",
    label: "JavaScript / TypeScript (vscode-js-debug)",
    languages: { ts: "pwa-node" },
    childSessions: true,
  },
  { id: "lldb", label: "Rust, C and C++ (lldb-dap)", languages: { rs: "lldb-dap" }, childSessions: false },
];

const calls: Invoke[] = [];
const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
let sessionCounter = 0;
/** What `dap_root_for` answers. The backend's walk, faked at the seam. */
let resolvedRoot = REPO;
/** What `fs_read_file` answers for a `package.json`. */
let packageJson = JSON.stringify({ scripts: { test: "vitest", dev: "vite" } });

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "file_exists":
        return Promise.resolve(true);
      case "fs_read_dir":
        return Promise.resolve([{ name: "package.json" }, { name: "pnpm-lock.yaml" }]);
      case "fs_read_file":
        return Promise.resolve(packageJson);
      case "dap_registry":
        return Promise.resolve(REGISTRY);
      case "dap_root_for":
        return Promise.resolve(resolvedRoot);
      case "dap_launch_env":
        return Promise.resolve({ PATH: "/Users/x/.volta/bin:/usr/bin" });
      case "dap_start":
      case "dap_connect": {
        const handle: Handle = {
          server: cmd === "dap_connect" ? (args!.server as string) : "dap0",
          session: `sess${sessionCounter++}`,
        };
        channels.set(handle.session, args!.onMessage as { onmessage: ((m: string) => void) | null });
        return Promise.resolve(handle);
      }
      case "dap_send": {
        const handle = args!.handle as Handle;
        const frame = JSON.parse(args!.message as string) as Record<string, unknown>;
        if (frame.type === "request") {
          void Promise.resolve().then(() =>
            channels.get(handle.session)?.onmessage?.(
              JSON.stringify({
                seq: 9000,
                type: "response",
                request_seq: frame.seq,
                command: frame.command,
                success: true,
                body: {},
              }),
            ),
          );
        }
        return Promise.resolve();
      }
      default:
        return Promise.resolve(null);
    }
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));

vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emit, emitWith, OPEN_IN_EDITOR, DEBUG_START, DEBUG_STOP, DEBUG_PICK } = await import("../../utils/events");
const { COMMANDS } = await import("../../utils/commands");
const dap = await import("../../utils/dapSessions");
const store = await import("../../utils/debugStore");

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

async function mountEditor() {
  const [selected] = createSignal<unknown>(selection);
  render(() => (
    <>
      <Editor selected={selected() as never} />
      <PaneView pinKind="file" />
    </>
  ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

/** Arrive at a file, the way the tree or a picker does. */
async function openFile(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  const name = path.split("/").pop()!;
  await waitFor(() => expect(tab(name)).toBeTruthy());
}

/** The config `dap_start` was reached with. There is no other route: the
 *  session map is private and the config goes out on the wire. */
function launchedConfig(): Record<string, unknown> | null {
  const send = calls.find((c) => {
    if (c.cmd !== "dap_send") return false;
    const frame = JSON.parse(c.args.message as string) as { command?: string };
    return frame.command === "launch" || frame.command === "attach";
  });
  if (!send) return null;
  const frame = JSON.parse(send.args.message as string) as { arguments: Record<string, unknown> };
  return frame.arguments;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.length = 0;
  channels.clear();
  sessionCounter = 0;
  resolvedRoot = REPO;
  packageJson = JSON.stringify({ scripts: { test: "vitest", dev: "vite" } });
  localStorage.clear();
  listening.ready = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await dap.stopAllDap();
  store.clearDebugConsole();
  cleanup();
  warn.mockRestore();
});

describe("the target picker", () => {
  it("opens on F5 when this workspace has never debugged anything", async () => {
    await mountEditor();
    await openFile(`${REPO}/src/index.ts`);

    emit(DEBUG_START);

    // Doing nothing on the first press is how a debugger stays undiscovered.
    await waitFor(() => expect(screen.getByText("Start debugging")).toBeTruthy());
    expect(screen.getByLabelText("What to debug")).toBeTruthy();
  });

  it("offers all three kinds from the palette", async () => {
    const ids = COMMANDS.filter((c) => c.id.startsWith("debug:")).map((c) => c.id);
    expect(ids).toEqual(["debug:file", "debug:script", "debug:attach"]);

    await mountEditor();
    emitWith(DEBUG_PICK, { kind: "attach" });

    // Opened straight on the kind the row named, rather than on a default the
    // user then has to correct.
    await waitFor(() => expect(screen.getByText("Inspector port")).toBeTruthy());
    expect((screen.getByPlaceholderText("9229") as HTMLInputElement).value).toBe("9229");
  });

  it("offers the resolved root's scripts, not the workspace root's", async () => {
    resolvedRoot = PKG;
    packageJson = JSON.stringify({ scripts: { "api:serve": "node ." } });
    await mountEditor();
    await openFile(`${PKG}/src/index.ts`);

    emitWith(DEBUG_PICK, { kind: "script" });

    // In a monorepo these are the package's own scripts, which is the only list
    // runnable from the `cwd` the config will carry.
    await waitFor(() => expect(screen.getByText("api:serve")).toBeTruthy());
    const asked = calls.find((c) => c.cmd === "dap_root_for");
    expect(asked?.args.filePath).toBe(`${PKG}/src/index.ts`);
  });

  it("says what is missing rather than looking broken", async () => {
    packageJson = JSON.stringify({ name: "x" });
    await mountEditor();

    emitWith(DEBUG_PICK, { kind: "script" });

    await waitFor(() => expect(screen.getByText(/No scripts in this project's package.json/)).toBeTruthy());
  });
});

describe("starting a run", () => {
  it("launches the active file at the root the backend resolved", async () => {
    resolvedRoot = PKG;
    await mountEditor();
    await openFile(`${PKG}/src/index.ts`);

    emit(DEBUG_START);
    await waitFor(() => expect(screen.getByText("Start debugging")).toBeTruthy());
    fireEvent.click(screen.getByText("Start"));
    await flush();

    const config = await waitFor(() => {
      const c = launchedConfig();
      expect(c).not.toBeNull();
      return c!;
    });
    expect(config).toMatchObject({
      request: "launch",
      program: `${PKG}/src/index.ts`,
      // Not the workspace root: `cwd` decides module resolution and where
      // source maps resolve from.
      cwd: PKG,
      console: "internalConsole",
      stopOnEntry: true,
    });
    expect((config.env as Record<string, string>).PATH).toContain("/.volta/bin");
  });

  it("repeats the last target on the next F5, without asking again", async () => {
    await mountEditor();
    await openFile(`${REPO}/src/index.ts`);

    emitWith(DEBUG_PICK, { kind: "attach" });
    await waitFor(() => expect(screen.getByText("Inspector port")).toBeTruthy());
    fireEvent.input(screen.getByPlaceholderText("9229"), { target: { value: "5858" } });
    fireEvent.click(screen.getByText("Start"));
    await flush();
    await waitFor(() => expect(launchedConfig()).not.toBeNull());
    expect(launchedConfig()).toMatchObject({ request: "attach", port: 5858 });

    // The run is live, so a second F5 joins it rather than asking; end it first
    // so the repeat is the thing under test.
    await dap.stopAllDap();
    calls.length = 0;
    emit(DEBUG_START);
    await flush();

    // No dialog: F5 means "again".
    expect(screen.queryByText("Start debugging")).toBeNull();
    await waitFor(() => expect(launchedConfig()).toMatchObject({ port: 5858 }));
  });

  it("asks again when the remembered file is no longer open", async () => {
    await mountEditor();
    await openFile(`${REPO}/src/gone.ts`);
    emit(DEBUG_START);
    await waitFor(() => expect(screen.getByText("Start debugging")).toBeTruthy());
    fireEvent.click(screen.getByText("Start"));
    await flush();
    await dap.stopAllDap();

    // Scoped to the drawn tab: the measuring ghost carries a close affordance
    // of the same name.
    fireEvent.click(closeOf("gone.ts"));
    await waitFor(() => expect(tabs("gone.ts")).toHaveLength(0));

    emit(DEBUG_START);

    // A remembered file target whose tab is gone is not a target any more, and
    // silently launching it would be worse than asking.
    await waitFor(() => expect(screen.getByText("Start debugging")).toBeTruthy());
  });

  it("ends the run on Shift+F5", async () => {
    await mountEditor();
    await openFile(`${REPO}/src/index.ts`);
    emit(DEBUG_START);
    await waitFor(() => expect(screen.getByText("Start debugging")).toBeTruthy());
    fireEvent.click(screen.getByText("Start"));
    await flush();
    await waitFor(() => expect(dap.debugRoots()).toHaveLength(1));

    emit(DEBUG_STOP);

    // Stopping the run is what actually ends the debuggee: the backend kills
    // the adapter's whole process group.
    await waitFor(() => expect(dap.debugRoots()).toHaveLength(0));
    expect(calls.some((c) => c.cmd === "dap_stop")).toBe(true);
  });

  it("follows the active file's adapter across a .rs then .ts switch", async () => {
    await mountEditor();
    await openFile(`${REPO}/src/index.ts`);
    emit(DEBUG_START);
    await waitFor(() => expect(screen.getByText("Start debugging")).toBeTruthy());
    fireEvent.click(screen.getByText("Start"));
    await flush();
    await dap.stopAllDap();

    // The .rs file belongs to another adapter, so js-debug's target is not the
    // one to repeat: F5 asks, on that adapter's picker.
    await openFile(`${REPO}/src/main.rs`);
    calls.length = 0;
    emit(DEBUG_START);
    // No Cargo.toml at the root, so lldb's picker opens on a program to name.
    await waitFor(() => expect(screen.getByText("Enter the path of a program built with debug info.")).toBeTruthy());
    expect(launchedConfig()).toBeNull();
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Start debugging")).toBeNull());

    // Back on the .ts file, F5 repeats js-debug's target without asking.
    await openFile(`${REPO}/src/index.ts`);
    emit(DEBUG_START);
    await flush();
    expect(screen.queryByText("Start debugging")).toBeNull();
    await waitFor(() => expect(launchedConfig()).toMatchObject({ program: `${REPO}/src/index.ts` }));
  });

  it("repeats the workspace's last target from a tab no adapter claims", async () => {
    await mountEditor();
    await openFile(`${REPO}/src/index.ts`);
    emit(DEBUG_START);
    await waitFor(() => expect(screen.getByText("Start debugging")).toBeTruthy());
    fireEvent.click(screen.getByText("Start"));
    await flush();
    await dap.stopAllDap();

    await openFile(`${REPO}/README.md`);
    calls.length = 0;
    emit(DEBUG_START);
    await flush();

    // A README has no debugger, so it has no say: F5 means "again".
    expect(screen.queryByText("Start debugging")).toBeNull();
    await waitFor(() => expect(launchedConfig()).toMatchObject({ program: `${REPO}/src/index.ts` }));
  });

  it("offers a choice of debugger from a tab no adapter claims, with nothing to repeat", async () => {
    await mountEditor();
    await openFile(`${REPO}/README.md`);

    emit(DEBUG_START);

    await waitFor(() => expect(screen.getByText("Debugger")).toBeTruthy());
  });

  it("remembers the attach port per workspace, across a reload", async () => {
    await mountEditor();
    emitWith(DEBUG_PICK, { kind: "attach" });
    await waitFor(() => expect(screen.getByText("Inspector port")).toBeTruthy());
    fireEvent.input(screen.getByPlaceholderText("9229"), { target: { value: "5858" } });
    fireEvent.click(screen.getByText("Start"));
    await flush();
    await dap.stopAllDap();

    // A reload is a fresh mount reading the same storage.
    cleanup();
    listening.ready = false;
    await mountEditor();
    emitWith(DEBUG_PICK, { kind: "attach" });

    await waitFor(() => expect((screen.getByPlaceholderText("9229") as HTMLInputElement).value).toBe("5858"));
  });
});
