import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The pane's view of a debug run: the session tree as a signal, the console
// transcript, and the sanitising that stands between a program's stdout and the
// DOM. Driven through the real `dapSessions` against a fake adapter, so what is
// asserted is what an `output` event actually produces rather than what a
// hand-built store would.

type Handle = { server: string; session: string };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
let sessionCounter = 0;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "dap_start" || cmd === "dap_connect") {
      const handle: Handle = {
        server: cmd === "dap_connect" ? (args!.server as string) : "dap0",
        session: `sess${sessionCounter++}`,
      };
      channels.set(handle.session, args!.onMessage as { onmessage: ((m: string) => void) | null });
      return Promise.resolve(handle);
    }
    if (cmd === "dap_send") {
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
            body: frame.command === "initialize" ? { supportsConfigurationDoneRequest: true } : {},
          }),
        );
      }
    }
    return Promise.resolve();
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

function output(session: string, text: string, category?: string): void {
  event(session, "output", { category, output: text });
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function freshModules() {
  vi.resetModules();
  const sessions = await import("./dapSessions");
  // Imported second and for its side effect: the store subscribes to
  // `dapSessions` at module load, so it must be evaluated after the module it
  // watches and before the first run starts.
  const store = await import("./debugStore");
  return { sessions, store };
}

const start = {
  adapterId: "js-debug",
  filePath: "/p/src/index.ts",
  projectPath: "/p",
  config: { type: "pwa-node", request: "launch", program: "/p/src/index.ts" },
};

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sessionCounter = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("sanitising program output", () => {
  it("keeps newlines and strips every other control byte", async () => {
    const { store } = await freshModules();
    // The bracketed-paste terminator is the concrete case: program output is
    // text nobody on this machine wrote, and a payload that can end its own
    // framing is how data becomes input somewhere downstream.
    expect(store.sanitizeOutput("a\x1b[201~b")).toBe("a[201~b");
    expect(store.sanitizeOutput("tint\x1b[31mtext\x1b[0m")).toBe("tint[31mtext[0m");
    expect(store.sanitizeOutput("bell\x07 and null\x00")).toBe("bell and null");
    // Structure survives, because a console's lines are its shape.
    expect(store.sanitizeOutput("one\ntwo\n")).toBe("one\ntwo\n");
    // CRLF and a lone CR both normalise, so a Windows-y program does not
    // produce a blank line between every line of output.
    expect(store.sanitizeOutput("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
    // Tabs become spaces rather than vanishing: an indented stack trace read
    // with its tabs deleted is worse than one read with them widened.
    expect(store.sanitizeOutput("a\tb")).toBe("a  b");
  });
});

describe("the console", () => {
  it("splits output by category and drops telemetry", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    const id = root!.handle.session;

    output(id, "to stdout\n", "stdout");
    output(id, "to stderr\n", "stderr");
    output(id, "from the adapter\n", "console");
    output(id, "vendor metrics\n", "telemetry");

    const lines = store.consoleLines();
    expect(lines.map((l) => `${l.category}:${l.text}`)).toEqual([
      "stdout:to stdout",
      "stderr:to stderr",
      "console:from the adapter",
    ]);
    // Telemetry is the adapter reporting on itself to its vendor, not program
    // output; shown, it is noise in the middle of somebody's stdout.
    expect(lines.some((l) => l.text.includes("vendor"))).toBe(false);
  });

  it("defaults a category-less event to console and keeps an unknown one visible", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    const id = root!.handle.session;

    output(id, "no category\n");
    output(id, "from the future\n", "somethingNew");

    // Dropping is reserved for telemetry: an unrecognised category is still
    // somebody's output, and hiding it is worse than mislabelling it.
    expect(store.consoleLines().map((l) => l.category)).toEqual(["console", "console"]);
    expect(store.consoleLines().map((l) => l.text)).toEqual(["no category", "from the future"]);
  });

  it("names the session each line came from", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    deliver(root!.handle.session, {
      seq: 500,
      type: "request",
      command: "startDebugging",
      arguments: { configuration: { __pendingTargetId: "t1" }, request: "launch" },
    });
    await flush();
    const child = root!.children[0];

    output(root!.handle.session, "from the root\n", "stdout");
    output(child, "from the child\n", "stdout");

    // A run has several sessions and their output interleaves; which one said a
    // thing is most of what makes the interleaving readable.
    expect(store.consoleLines().map((l) => [l.sessionName, l.text])).toEqual([
      ["run0", "from the root"],
      ["run0.child0", "from the child"],
    ]);
  });

  it("treats one trailing newline as a terminator, not an empty line", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    output(root!.handle.session, "one line\n", "stdout");
    expect(store.consoleLines()).toHaveLength(1);

    output(root!.handle.session, "two\nlines\n", "stdout");
    expect(store.consoleLines().map((l) => l.text)).toEqual(["one line", "two", "lines"]);
  });

  it("caps the transcript rather than growing without bound", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    const id = root!.handle.session;
    const chunk = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    for (let i = 0; i < 6; i++) output(id, chunk, "stdout");

    // A runaway program outruns any reader, and this store lives as long as the
    // app does.
    expect(store.consoleLines()).toHaveLength(store.MAX_CONSOLE_LINES);
    // The oldest go, so what is on screen is what just happened.
    expect(store.consoleLines()[store.consoleLines().length - 1].text).toBe("line 999");
  });

  it("clears when a new run replaces a finished one", async () => {
    const { sessions, store } = await freshModules();
    const first = await sessions.startDebugSession(start);
    await flush();
    output(first!.handle.session, "from the first run\n", "stdout");
    expect(store.consoleLines()).toHaveLength(1);

    event(first!.handle.session, "terminated");
    await flush();
    // A finished run stays readable: its output is the answer to what happened.
    expect(store.consoleLines()).toHaveLength(1);

    await sessions.startDebugSession(start);
    await flush();
    expect(store.consoleLines()).toHaveLength(0);
  });
});

describe("the session tree", () => {
  it("mirrors dapSessions, with depth", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    deliver(root!.handle.session, {
      seq: 500,
      type: "request",
      command: "startDebugging",
      arguments: { configuration: { __pendingTargetId: "t1" }, request: "launch" },
    });
    await flush();

    expect(store.debugTree()).toHaveLength(1);
    expect(store.debugTree()[0].name).toBe("run0");
    expect(store.debugTree()[0].children.map((c) => c.name)).toEqual(["run0.child0"]);
    expect(store.debugRunning()).toBe(true);
  });

  it("picks up a run that was already live when it loaded", async () => {
    vi.resetModules();
    const sessions = await import("./dapSessions");
    const root = await sessions.startDebugSession(start);
    await flush();

    // Imported only now, with a run already going. Subscribing to changes and
    // nothing else would make this module's import order load-bearing: the run
    // would be invisible and its output would never appear, with nothing
    // logged. Editor imports this eagerly today, which is exactly the kind of
    // guarantee a later entry point moves without noticing.
    const store = await import("./debugStore");

    expect(store.debugRunning()).toBe(true);
    expect(store.debugTree()[0].name).toBe(root!.name);
    // And it is wired, not merely counted.
    output(root!.handle.session, "after the fact\n", "stdout");
    expect(store.consoleLines().map((l) => l.text)).toEqual(["after the fact"]);
  });

  it("is idle until the adapter has answered initialize", async () => {
    const { sessions, store } = await freshModules();
    const pending = sessions.startDebugSession(start);
    // One turn: enough for the session to be registered, not enough for the
    // handshake to come back. "Starting" and "Running" are different things to
    // be told when a launch is slow, and collapsing them hides the slow part.
    await flush(2);
    expect(store.debugTree()[0]?.state).toBe("idle");

    await pending;
    await flush();
    expect(store.debugTree()[0].state).toBe("running");
  });

  it("moves a session through running, stopped and back", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    const id = root!.handle.session;

    // The handshake has landed, so the session is past `idle`.
    expect(store.debugTree()[0].state).toBe("running");

    event(id, "stopped", { reason: "breakpoint", threadId: 0 });
    expect(store.debugTree()[0].state).toBe("stopped");

    event(id, "continued", { threadId: 0 });
    expect(store.debugTree()[0].state).toBe("running");
  });

  it("never surfaces the entry pause as a stop", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    const id = root!.handle.session;

    // Sway asked for this pause itself, so a source map has time to resolve,
    // and continues straight through it. Showing it would flash a paused state
    // nobody asked for at the start of every launch.
    event(id, "stopped", { reason: "entry", threadId: 0 });
    expect(store.debugTree()[0].state).toBe("running");

    event(id, "stopped", { reason: "breakpoint", threadId: 0 });
    expect(store.debugTree()[0].state).toBe("stopped");
  });

  it("empties when the run ends, and says nothing is running", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    expect(store.debugRunning()).toBe(true);

    event(root!.handle.session, "terminated");
    await flush();

    expect(store.debugTree()).toEqual([]);
    expect(store.debugRunning()).toBe(false);
  });

  it("keeps a parent running when only a child ends", async () => {
    const { sessions, store } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    deliver(root!.handle.session, {
      seq: 500,
      type: "request",
      command: "startDebugging",
      arguments: { configuration: { __pendingTargetId: "t1" }, request: "launch" },
    });
    await flush();
    const child = root!.children[0];

    event(child, "terminated");
    await flush();

    expect(store.debugRunning()).toBe(true);
    expect(store.debugTree()[0].children).toEqual([]);
  });
});
