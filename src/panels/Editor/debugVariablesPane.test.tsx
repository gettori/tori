import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";

// Scopes and variables, from the pane's side.
//
// `debugVariables.ts` owns what is fetched and when, and is tested on its own
// against a fake adapter. This is the part it cannot see: that a scope opens on
// a click, that a long container says how much of it is missing, and that the
// edit control is present exactly when the adapter serves `setVariable`.

const REPO = "/space/proj/main";
const FILE = `${REPO}/src/index.ts`;

type Handle = { server: string; session: string };
type Sent = { command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
let sessionCounter = 0;
/** What `initialize` answers, so a test can withhold `supportsSetVariable`. */
let capabilities: Record<string, unknown> = {
  supportsConfigurationDoneRequest: true,
  supportsSetVariable: true,
};
let variableAnswers = new Map<string, unknown[]>();
/** What `setVariable` answers. The container is deliberately left reporting the
 *  old value, the way js-debug's snapshot containers do. */
let setResult = "42";
const failCommands = new Set<string>();

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
          const failed = failCommands.has(command);
          void Promise.resolve().then(() =>
            deliver(handle.session, {
              seq: 9000,
              type: "response",
              request_seq: frame.seq,
              command,
              success: !failed,
              ...(failed ? { message: "Cannot set this variable" } : {}),
              body: bodyFor(command, requestArgs),
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

function bodyFor(command: string, args: Record<string, unknown>): unknown {
  if (command === "initialize") return capabilities;
  if (command === "stackTrace")
    return {
      stackFrames: [{ id: 1, name: "total", source: { path: FILE, name: "index.ts" }, line: 6 }],
    };
  if (command === "scopes")
    return {
      scopes: [
        { name: "Locals", variablesReference: 100, expensive: false },
        { name: "Global", variablesReference: 200, expensive: true },
      ],
    };
  if (command === "variables") {
    const key = `${args.variablesReference}:${(args.filter as string) ?? ""}`;
    return { variables: variableAnswers.get(key) ?? [] };
  }
  if (command === "setVariable") return { value: setResult, variablesReference: 0 };
  return {};
}

const { default: DebugPanel } = await import("./DebugPanel");
const dap = await import("../../utils/dapSessions");

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

const start = {
  adapterId: "js-debug",
  filePath: FILE,
  projectPath: REPO,
  config: { type: "pwa-node", request: "launch", program: FILE },
};

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A run paused at a breakpoint with the pane on screen. */
async function pausedPane() {
  const root = await dap.startDebugSession(start);
  await flush();
  render(() => <DebugPanel root={REPO} selected={null} />);
  event(root!.handle.session, "stopped", { reason: "breakpoint", threadId: 3 });
  await waitFor(() => expect(screen.queryByText("Locals")).toBeTruthy());
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  sessionCounter = 0;
  capabilities = { supportsConfigurationDoneRequest: true, supportsSetVariable: true };
  variableAnswers = new Map<string, unknown[]>([
    [
      "100:",
      [
        { name: "count", value: "3", type: "number", variablesReference: 0 },
        { name: "user", value: "Object", type: "object", variablesReference: 300 },
      ],
    ],
    ["300:", [{ name: "id", value: "'u1'", variablesReference: 0 }]],
  ]);
  setResult = "42";
  failCommands.clear();
  localStorage.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await dap.stopAllDap();
  await flush();
  cleanup();
  warn.mockRestore();
});

const sentCommands = (name: string) => sent.filter((s) => s.command === name);

describe("the scopes section", () => {
  it("lists the frame's scopes closed, having read none of them", async () => {
    await pausedPane();

    expect(screen.getByText("Global")).toBeTruthy();
    // Closed is the point: expanding Global on arrival would read thousands of
    // entries nobody asked for.
    expect(screen.queryByText("count")).toBeNull();
    expect(sentCommands("variables")).toEqual([]);
    // The adapter's own warning is passed through rather than acted on.
    expect(screen.getByText("slow")).toBeTruthy();
  });

  it("opens a scope on a click and shows what is in it", async () => {
    await pausedPane();

    fireEvent.click(screen.getByText("Locals"));
    await waitFor(() => expect(screen.queryByText("count")).toBeTruthy());

    expect(sentCommands("variables")[0].args.variablesReference).toBe(100);
    expect(screen.getByText("user")).toBeTruthy();
  });

  it("opens a nested object under the row that holds it", async () => {
    await pausedPane();
    fireEvent.click(screen.getByText("Locals"));
    await waitFor(() => expect(screen.queryByText("user")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Expand user"));
    await waitFor(() => expect(screen.queryByText("id")).toBeTruthy());

    // A row with no children offers nothing to click, so there is exactly one
    // expander among the two rows.
    expect(screen.queryByLabelText("Expand count")).toBeNull();
  });

  it("has nothing to show while the program runs", async () => {
    const root = await dap.startDebugSession(start);
    await flush();
    render(() => <DebugPanel root={REPO} selected={null} />);
    await flush();

    expect(screen.queryByText("Locals")).toBeNull();
    expect(root).toBeTruthy();
  });
});

describe("a container longer than one page", () => {
  beforeEach(() => {
    variableAnswers.set("100:", [
      { name: "rows", value: "Array(1000)", variablesReference: 400, indexedVariables: 1000 },
    ]);
    variableAnswers.set("400:named", [{ name: "length", value: "1000", variablesReference: 0 }]);
    variableAnswers.set(
      "400:indexed",
      Array.from({ length: 100 }, (_, i) => ({ name: `i${i}`, value: `e${i}`, variablesReference: 0 })),
    );
  });

  it("says how much of it is not on screen, and fetches the rest on request", async () => {
    await pausedPane();
    fireEvent.click(screen.getByText("Locals"));
    await waitFor(() => expect(screen.queryByText("rows")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Expand rows"));
    await waitFor(() => expect(screen.queryByText("i0")).toBeTruthy());

    // A truncated list that says nothing is indistinguishable from a short one.
    const more = screen.getByText(/Show 100 more of 900/);
    fireEvent.click(more);
    await waitFor(() => expect(screen.queryByText(/Show 100 more of 800/)).toBeTruthy());

    const pages = sentCommands("variables").filter((c) => c.args.filter === "indexed");
    expect(pages.map((c) => c.args.start)).toEqual([0, 100]);
  });
});

describe("setting a value", () => {
  it("edits in place and shows what the adapter answered", async () => {
    await pausedPane();
    fireEvent.click(screen.getByText("Locals"));
    await waitFor(() => expect(screen.queryByText("count")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Set count"));
    const input = screen.getByLabelText("Value of count") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "40 + 2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByLabelText("Set count")?.textContent).toBe("42"));

    expect(sentCommands("setVariable")[0].args).toMatchObject({
      variablesReference: 100,
      name: "count",
      value: "40 + 2",
    });
    // The adapter's answer, not the typed expression.
    expect(screen.getByLabelText("Set count").textContent).toBe("42");
  });

  it("offers no control at all when the adapter does not serve it", async () => {
    capabilities = { supportsConfigurationDoneRequest: true };
    await pausedPane();
    fireEvent.click(screen.getByText("Locals"));
    await waitFor(() => expect(screen.queryByText("count")).toBeTruthy());

    // Absent rather than disabled: a control that always fails is worse than no
    // control, because it reads as a feature that is broken.
    expect(screen.queryByLabelText("Set count")).toBeNull();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("says why a refused edit did not take", async () => {
    failCommands.add("setVariable");
    await pausedPane();
    fireEvent.click(screen.getByText("Locals"));
    await waitFor(() => expect(screen.queryByText("count")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Set count"));
    const input = screen.getByLabelText("Value of count") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByText(/Cannot set this variable/)).toBeTruthy());
    // The old value stands, so nobody reads a number the program does not hold.
    expect(screen.getByLabelText("Set count").textContent).toBe("3");
  });

  it("leaves the value alone on Escape", async () => {
    await pausedPane();
    fireEvent.click(screen.getByText("Locals"));
    await waitFor(() => expect(screen.queryByText("count")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Set count"));
    const input = screen.getByLabelText("Value of count") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await flush();

    expect(sentCommands("setVariable")).toEqual([]);
    expect(screen.getByLabelText("Set count").textContent).toBe("3");
  });
});
