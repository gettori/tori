import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";

// Execution controls and the call stack, from the pane's side.
//
// `debugStack.ts` owns what a pause is and what each control sends, and is
// tested on its own against a fake adapter. This is the part it cannot see:
// that the toolbar is gated on the state it claims to be gated on, that a frame
// row is clickable and reaches the editor, and that the paused line is handed to
// the buffer holding it.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/index.ts`;
/** What the adapter hands back for a frame with no file on disk. */
const BUNDLED_SOURCE = "function requireModule(id) {\n  return cache[id];\n}\n";

type Handle = { server: string; session: string };
type Sent = { command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
let sessionCounter = 0;
let frames: unknown[] = [];

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
        return Promise.resolve(true);
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
          sent.push({
            command: frame.command as string,
            args: (frame.arguments ?? {}) as Record<string, unknown>,
          });
          void Promise.resolve().then(() =>
            deliver(handle.session, {
              seq: 9000,
              type: "response",
              request_seq: frame.seq,
              command: frame.command,
              success: true,
              body:
                frame.command === "stackTrace"
                  ? { stackFrames: frames }
                  : frame.command === "source"
                    ? { content: BUNDLED_SOURCE }
                    : {},
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

type CodeProps = {
  activePath: string | null;
  frameLine?: { path: string; line: number } | null;
  goto?: { path: string; line: number; nonce: number } | null;
};
let code: CodeProps | null = null;
vi.mock("./CodeEditor", () => ({
  default: (p: CodeProps) => {
    code = p;
    return null;
  },
}));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), retainLspRoots: () => Promise.resolve() }));

const { default: DebugPanel } = await import("./DebugPanel");
const { default: Editor } = await import("./Editor");
const dap = await import("../../utils/dapSessions");
const store = await import("../../utils/debugStore");
const { emitWith, OPEN_IN_EDITOR } = await import("../../utils/events");

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const start = {
  adapterId: "js-debug",
  filePath: FILE,
  projectPath: REPO,
  config: { type: "pwa-node", request: "launch", program: FILE },
};

/** A live run, from the pane's point of view. */
async function startRun() {
  const root = await dap.startDebugSession(start);
  await flush();
  return root!.handle.session;
}

const button = (label: string) => screen.getByLabelText(label) as HTMLButtonElement;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  sessionCounter = 0;
  listening.ready = false;
  code = null;
  frames = [
    { id: 1, name: "total", source: { path: FILE, name: "index.ts" }, line: 6, column: 3 },
    { id: 2, name: "main", source: { path: FILE, name: "index.ts" }, line: 12, column: 1 },
  ];
  localStorage.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await dap.stopAllDap();
  store.clearDebugConsole();
  cleanup();
  warn.mockRestore();
});

describe("the toolbar", () => {
  it("offers pause while running and step nothing", async () => {
    await startRun();
    render(() => <DebugPanel root={REPO} selected={null} />);
    await waitFor(() => expect(screen.queryByLabelText("Pause")).toBeTruthy());

    // Continue and pause are the two halves of one state, so exactly one of
    // them is ever on screen.
    expect(screen.queryByLabelText("Continue")).toBeNull();
    // Disabled rather than hidden: a toolbar whose buttons come and go is one
    // nobody can build muscle memory for.
    expect(button("Step over").disabled).toBe(true);
    expect(button("Step into").disabled).toBe(true);
    expect(button("Step out").disabled).toBe(true);
    // These two do not depend on the program being paused.
    expect(button("Restart").disabled).toBe(false);
    expect(button("Stop").disabled).toBe(false);
  });

  it("opens up when the program stops", async () => {
    const id = await startRun();
    render(() => <DebugPanel root={REPO} selected={null} />);
    await waitFor(() => expect(screen.queryByLabelText("Pause")).toBeTruthy());

    event(id, "stopped", { reason: "breakpoint", threadId: 3 });
    await waitFor(() => expect(screen.queryByLabelText("Continue")).toBeTruthy());

    expect(screen.queryByLabelText("Pause")).toBeNull();
    expect(button("Step over").disabled).toBe(false);
    expect(button("Step into").disabled).toBe(false);
    expect(button("Step out").disabled).toBe(false);
  });

  it("sends the step the button names", async () => {
    const id = await startRun();
    render(() => <DebugPanel root={REPO} selected={null} />);
    await waitFor(() => expect(screen.queryByLabelText("Pause")).toBeTruthy());
    event(id, "stopped", { reason: "breakpoint", threadId: 3 });
    await waitFor(() => expect(screen.queryByLabelText("Continue")).toBeTruthy());
    sent.length = 0;

    fireEvent.click(button("Step into"));
    await flush();

    expect(sent.map((s) => s.command)).toEqual(["stepIn"]);
    expect(sent[0].args).toMatchObject({ threadId: 3 });
  });
});

describe("the call stack", () => {
  it("lists the paused session's frames, with the top one selected", async () => {
    const id = await startRun();
    render(() => <DebugPanel root={REPO} selected={null} />);
    event(id, "stopped", { reason: "breakpoint", threadId: 3 });

    await waitFor(() => expect(screen.queryByText("total")).toBeTruthy());
    // Named, because a run pauses in one of its sessions and "which of them" is
    // the first thing to know about a frame.
    expect(screen.getByText(/paused on breakpoint/)).toBeTruthy();
    expect(screen.getByText("index.ts:6")).toBeTruthy();
    expect(screen.getByText("total").closest("button")?.getAttribute("aria-current")).toBe("true");
  });

  it("says so when a pause has no frames", async () => {
    frames = [];
    const id = await startRun();
    render(() => <DebugPanel root={REPO} selected={null} />);
    event(id, "stopped", { reason: "pause", threadId: 3 });

    // Better than an empty box: the pause is real even when the stack is not.
    await waitFor(() => expect(screen.queryByText("No frames for this pause.")).toBeTruthy());
  });
});

describe("from the pane to the editor", () => {
  async function mountEditor() {
    const [selected] = createSignal<unknown>({
      spaceName: "space",
      projectName: "proj",
      projectPath: "/space/proj",
      folderPath: REPO,
      branch: "main",
      projectKind: "plain",
    });
    render(() => (
      <>
        <Editor selected={selected() as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(listening.ready).toBe(true));
    emitWith(OPEN_IN_EDITOR, { path: FILE });
    await waitFor(() => expect(code?.activePath).toBe(FILE));
  }

  it("hands the paused line to the buffer that holds it, and takes it back", async () => {
    await mountEditor();
    const id = await startRun();

    event(id, "stopped", { reason: "breakpoint", threadId: 3 });
    // The stripe is what says "you are here", and it is the pane that knows
    // where here is.
    await waitFor(() => expect(code!.frameLine).toEqual({ path: FILE, line: 6 }));

    event(id, "continued", { threadId: 3 });
    await waitFor(() => expect(code!.frameLine).toBeNull());
  });

  it("opens code with no file behind it as a readable tab", async () => {
    frames = [
      {
        id: 4,
        name: "requireModule",
        source: { name: "node:internal/modules", sourceReference: 12 },
        line: 2,
      },
    ];
    await mountEditor();
    const id = await startRun();

    event(id, "stopped", { reason: "breakpoint", threadId: 3 });

    // Stepping into a bundled dependency lands in code that exists only inside
    // the runtime. There is no path any editor could open, so the content comes
    // back by reference and opens as its own read-only view.
    await waitFor(() => expect(screen.queryByText("return cache[id];")).toBeTruthy());
    expect(screen.getByText("from the debugger, read-only")).toBeTruthy();
    // The editor is not asked to show a path that is not on disk.
    expect(code!.activePath).toBeNull();
    expect(code!.frameLine).toBeNull();
    // And it is named after the source rather than after the reference number,
    // in the tab strip and in the view's own header.
    expect(screen.getAllByText("node:internal/modules").length).toBeGreaterThan(1);
  });

  it("opens a clicked frame at its own line", async () => {
    await mountEditor();
    const id = await startRun();
    render(() => <DebugPanel root={REPO} selected={null} />);
    event(id, "stopped", { reason: "breakpoint", threadId: 3 });
    await waitFor(() => expect(screen.queryByText("main")).toBeTruthy());

    fireEvent.click(screen.getByText("main").closest("button")!);

    // Line 12, not the top frame's 6: clicking a frame is asking to be looking
    // at that frame.
    await waitFor(() => expect(code!.goto).toMatchObject({ path: FILE, line: 12 }));
    await waitFor(() => expect(code!.frameLine).toEqual({ path: FILE, line: 12 }));
  });
});
