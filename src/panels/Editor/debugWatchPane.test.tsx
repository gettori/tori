import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";

// Watches and the console's input, from the pane's side.
//
// `debugWatch.ts` and `debugRepl.ts` own what is asked and when, and are tested
// against a fake adapter. This is what they cannot see: that a watch survives a
// reload, that reordering is reachable without a mouse gesture nobody can test,
// and that an entry typed after a run has ended says so.

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/index.ts`;

type Handle = { server: string; session: string };
type Sent = { command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
let sessionCounter = 0;
let evaluations = new Map<string, { result?: string; fail?: string }>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
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
          const command = frame.command as string;
          const requestArgs = (frame.arguments ?? {}) as Record<string, unknown>;
          sent.push({ command, args: requestArgs });
          const answer =
            command === "evaluate" ? evaluations.get(requestArgs.expression as string) : undefined;
          const failed = Boolean(answer?.fail);
          void Promise.resolve().then(() =>
            deliver(handle.session, {
              seq: 9000,
              type: "response",
              request_seq: frame.seq,
              command,
              success: !failed,
              ...(failed ? { message: answer!.fail } : {}),
              body: bodyFor(command, answer),
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

function bodyFor(command: string, answer?: { result?: string }): unknown {
  if (command === "initialize") return { supportsConfigurationDoneRequest: true };
  if (command === "stackTrace")
    return {
      stackFrames: [{ id: 1, name: "total", source: { path: FILE, name: "index.ts" }, line: 6 }],
    };
  if (command === "scopes") return { scopes: [] };
  if (command === "evaluate") return { result: answer?.result ?? "?" };
  return {};
}

const { default: DebugPanel } = await import("./DebugPanel");
const dap = await import("../../utils/dapSessions");
const store = await import("../../utils/debugStore");
const { loadWatches } = await import("../../utils/watches");
const watch = await import("../../utils/debugWatch");

/** The watch store is module state that outlives one test, the way it outlives
 *  one mount in the app. Emptied through its own API rather than a test-only
 *  reset, so nothing here can pass against a door that does not exist. */
function clearWatches() {
  while (watch.watchRows(REPO).length) watch.removeWatchExpression(REPO, 0);
}

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

async function flush(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const start = {
  adapterId: "js-debug",
  filePath: FILE,
  projectPath: REPO,
  config: { type: "pwa-node", request: "launch", program: FILE },
};

/** A run paused at a breakpoint with the pane on screen. */
async function pausedPane() {
  const root = await dap.startDebugSession(start);
  await flush();
  render(() => <DebugPanel root={REPO} selected={null} />);
  event(root!.handle.session, "stopped", { reason: "breakpoint", threadId: 3 });
  await waitFor(() => expect(screen.queryByLabelText("Continue")).toBeTruthy());
  return root!.handle.session;
}

/** Type into a named field and submit its form. */
function type(label: string, text: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.input(input, { target: { value: text } });
  fireEvent.submit(input.closest("form")!);
  return input;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  sessionCounter = 0;
  evaluations = new Map([
    ["count", { result: "3" }],
    ["user.name", { result: "'Ada'" }],
    ["nope", { fail: "nope is not defined" }],
  ]);
  clearWatches();
  localStorage.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await dap.stopAllDap();
  await flush();
  clearWatches();
  store.clearDebugConsole();
  cleanup();
  warn.mockRestore();
});

describe("the watch list", () => {
  it("is there before there is anything to answer it", async () => {
    render(() => <DebugPanel root={REPO} selected={null} />);

    // The point of a watch is that you write it once and it answers on every
    // run afterwards, so the list has to be editable with nothing running.
    expect(screen.getByLabelText("Watch expression")).toBeTruthy();
    expect(screen.getByText("Nothing is being watched.")).toBeTruthy();
  });

  it("answers a new expression against the paused frame", async () => {
    await pausedPane();

    type("Watch expression", "count");

    await waitFor(() => expect(screen.queryByText("3")).toBeTruthy());
    expect(screen.getByText("count")).toBeTruthy();
    // The input clears, so the next one is typed rather than edited over.
    expect((screen.getByLabelText("Watch expression") as HTMLInputElement).value).toBe("");
  });

  it("keeps the row and shows the message when an expression will not resolve", async () => {
    await pausedPane();

    type("Watch expression", "nope");

    await waitFor(() => expect(screen.queryByText(/nope is not defined/)).toBeTruthy());
    // The row stays, or there is nothing left to click to remove it.
    expect(screen.getByText("nope")).toBeTruthy();
  });

  it("survives a reload", async () => {
    render(() => <DebugPanel root={REPO} selected={null} />);
    type("Watch expression", "count");
    await flush();

    // Written through to storage rather than held in the pane, which unmounts
    // every time the right pane changes mode.
    expect(loadWatches()).toEqual({ [REPO]: ["count"] });
  });

  it("reorders and removes without a mouse gesture", async () => {
    render(() => <DebugPanel root={REPO} selected={null} />);
    type("Watch expression", "count");
    type("Watch expression", "user.name");
    await waitFor(() => expect(screen.queryByText("user.name")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Move user.name up"));
    await waitFor(() => expect(loadWatches()[REPO]).toEqual(["user.name", "count"]));
    // The row that is already first has nothing above it to swap with.
    expect((screen.getByLabelText("Move user.name up") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("Remove count"));
    await waitFor(() => expect(screen.queryByText("count")).toBeNull());
    expect(loadWatches()[REPO]).toEqual(["user.name"]);
  });
});

describe("the console's input", () => {
  it("echoes an entry and prints what came back", async () => {
    await pausedPane();

    type("Evaluate in the debug console", "count");

    await waitFor(() => expect(screen.queryByText("> count")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("3")).toBeTruthy());
    const repl = sent.filter((s) => s.command === "evaluate" && s.args.context === "repl");
    expect(repl[0].args).toMatchObject({ expression: "count", frameId: 1 });
  });

  it("walks back through what was entered", async () => {
    await pausedPane();
    type("Evaluate in the debug console", "count");
    type("Evaluate in the debug console", "user.name");
    await waitFor(() => expect(screen.queryByText("> user.name")).toBeTruthy());

    const input = screen.getByLabelText("Evaluate in the debug console") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("user.name");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("count");
    // Walking forward past the newest returns to the empty line being typed,
    // rather than sticking on the last entry.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("");
  });

  it("says there is no session rather than doing nothing", async () => {
    const id = await pausedPane();
    // A finished run leaves its transcript, which is exactly when somebody
    // types one more thing into the console.
    event(id, "output", { category: "stdout", output: "done\n" });
    await waitFor(() => expect(screen.queryByText("done")).toBeTruthy());
    await dap.stopAllDap();
    await flush();

    type("Evaluate in the debug console", "count");

    await waitFor(() =>
      expect(screen.queryByText(/No debug session\. Start one with F5/)).toBeTruthy(),
    );
  });
});
