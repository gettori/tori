import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import { tab, tabs } from "../../test/tabs";

// The Debug pane from the editor's side.
//
// `debugStore.ts` owns what a run looks like and is tested on its own. This is
// the part it cannot see: that the mode is registered at every site that has to
// know about it, that the pane is reachable by all three routes, and that a run
// ending underneath the reader moves the pane aside rather than leaving them
// staring at an empty one.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";

type Handle = { server: string; session: string };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
let sessionCounter = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "file_exists":
        return Promise.resolve(false);
      case "fs_read_dir":
        return Promise.resolve([]);
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
            deliver(handle.session, {
              seq: 9000,
              type: "response",
              request_seq: frame.seq,
              command: frame.command,
              success: true,
              body: {},
            }),
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

// The real editor is all of CodeMirror and owns none of this.
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, SET_RIGHT_MODE } = await import("../../utils/events");
const { COMMANDS } = await import("../../utils/commands");
const dap = await import("../../utils/dapSessions");
const store = await import("../../utils/debugStore");

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

async function flush(times = 8): Promise<void> {
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
  render(() => <Editor selected={selected() as never} />);
  await waitFor(() => expect(listening.ready).toBe(true));
}

/** Start a run against the fake adapter.
 *
 *  The name is read back rather than assumed: `dapSessions` numbers runs from a
 *  module-level counter that keeps climbing across tests in this file, so a
 *  hard-coded `run0` would pass first and fail everywhere after. */
async function startRun(): Promise<{ id: string; name: string }> {
  const root = await dap.startDebugSession({
    adapterId: "js-debug",
    filePath: `${REPO}/src/index.ts`,
    projectPath: REPO,
    config: { type: "pwa-node", request: "launch" },
  });
  await flush();
  return { id: root!.handle.session, name: root!.name };
}

const showDebug = () => emitWith(SET_RIGHT_MODE, { mode: "debug" });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sessionCounter = 0;
  // Per mount, not once: `onCloseRequested` is the last thing the editor's
  // `onMount` awaits, so it is what says the window listeners are registered.
  // Left latched, every mount after the first would be treated as ready before
  // it had subscribed to anything.
  listening.ready = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await dap.stopAllDap();
  store.clearDebugConsole();
  cleanup();
  warn.mockRestore();
});

describe("reaching the pane", () => {
  it("opens from the SET_RIGHT_MODE event with nothing running, and says so", async () => {
    await mountEditor();
    showDebug();

    // The empty state is the reason this mode is openable before a run exists:
    // a pane that renders blank teaches nothing.
    await waitFor(() => expect(screen.getByText(/Nothing is being debugged/)).toBeTruthy());
  });

  it("is offered in the command palette", async () => {
    const entry = COMMANDS.find((c) => c.id === "mode:debug");
    expect(entry).toBeTruthy();
    expect(entry!.label).toBe("Show Debug");

    // The palette's row does exactly what the event above does, so running it
    // is the same route proved once more from the other end.
    await mountEditor();
    entry!.run?.();
    await waitFor(() => expect(screen.getByText(/Nothing is being debugged/)).toBeTruthy());
  });

  it("gets a tab in the strip only once something is being debugged", async () => {
    await mountEditor();
    // No tab while nothing runs: an always-present "Debug" is a control that
    // does nothing on almost every project, almost all of the time.
    expect(tabs("Debug")).toHaveLength(0);

    const run = await startRun();

    const debugTab = await waitFor(() => tab("Debug"));
    fireEvent.click(debugTab);
    await waitFor(() => expect(screen.getByText(run.name)).toBeTruthy());
  });
});

describe("the console", () => {
  it("renders each category distinguishably and drops telemetry", async () => {
    await mountEditor();
    const run = await startRun();
    showDebug();
    await waitFor(() => expect(screen.getByText(run.name)).toBeTruthy());

    event(run.id, "output", { category: "stdout", output: "out line\n" });
    event(run.id, "output", { category: "stderr", output: "err line\n" });
    event(run.id, "output", { category: "console", output: "adapter line\n" });
    event(run.id, "output", { category: "telemetry", output: "vendor metrics\n" });

    const out = await waitFor(() => screen.getByText("out line"));
    const err = screen.getByText("err line");
    const con = screen.getByText("adapter line");
    // Distinguishable in the DOM, not merely present: each row carries its own
    // category class, which is what the stylesheet colours.
    const classOf = (el: HTMLElement) => el.parentElement!.className;
    expect(classOf(out)).not.toBe(classOf(err));
    expect(classOf(err)).not.toBe(classOf(con));

    expect(screen.queryByText(/vendor metrics/)).toBeNull();
  });

  it("renders control bytes literally, with no escape-sequence effect", async () => {
    await mountEditor();
    const run = await startRun();
    showDebug();
    await waitFor(() => expect(screen.getByText(run.name)).toBeTruthy());

    // A colour escape and a bracketed-paste terminator, the two shapes that
    // matter: one would repaint a terminal, the other would end the framing
    // that keeps a payload inert. Program output is text nobody here wrote.
    event(run.id, "output", { category: "stdout", output: "\x1b[31mloud\x1b[0m and \x1b[201~out\n" });

    const row = await waitFor(() => screen.getByText(/loud/));
    expect(row.textContent).toBe("[31mloud[0m and [201~out");
    expect(row.textContent).not.toContain("\x1b");
  });
});

describe("when a run ends", () => {
  it("moves the pane off debug", async () => {
    await mountEditor();
    const run = await startRun();
    showDebug();
    await waitFor(() => expect(screen.getByText(run.name)).toBeTruthy());

    event(run.id, "terminated");
    await flush();

    // The pane is not left showing an empty debugger somebody has to notice and
    // click away from; it hands the space back the way Problems and Outline do.
    await waitFor(() => expect(screen.queryByText(run.name)).toBeNull());
    await waitFor(() => expect(tabs("Debug")).toHaveLength(0));
    // Files, specifically: the pane is handed back to the mode every other
    // fallback lands on, not left on whatever happened to be next in the strip.
    const filesTab = tab("Files");
    expect(filesTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("leaves a deliberately opened empty pane alone", async () => {
    await mountEditor();
    showDebug();

    // Opened with nothing running, it stays open. The fallback is a transition,
    // not a state: falling back here would make the palette row unusable.
    await waitFor(() => expect(screen.getByText(/Nothing is being debugged/)).toBeTruthy());
    await flush();
    expect(screen.getByText(/Nothing is being debugged/)).toBeTruthy();
  });
});
