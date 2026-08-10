import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Where a paused program is, and what the six controls send.
//
// Driven through the real `dapSessions` against a fake adapter, so the requests
// asserted are the ones that would go out and the events are the ones js-debug
// actually sends. The pane's rendering of all this is tested separately.

type Handle = { server: string; session: string };
type Sent = { session: string; command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
const opened: { path: string; line?: number }[] = [];
let sessionCounter = 0;
/** What `stackTrace` answers with. */
let frames: unknown[] = [];
/** What `source` answers with. */
let sourceContent = "export const bundled = 1;\n";
/** Commands the fake adapter refuses. */
const failCommands = new Set<string>();

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
        sent.push({
          session: handle.session,
          command: frame.command as string,
          args: (frame.arguments ?? {}) as Record<string, unknown>,
        });
        const failed = failCommands.has(frame.command as string);
        void Promise.resolve().then(() =>
          deliver(handle.session, {
            seq: 9000,
            type: "response",
            request_seq: frame.seq,
            command: frame.command,
            success: !failed,
            ...(failed ? { message: "no" } : {}),
            body: bodyFor(frame.command as string),
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

// The pane opens a frame by emitting the same event go-to-definition uses, so
// this is the whole of "it opened the right file at the right line".
vi.mock("./events", async () => {
  const actual = await vi.importActual<typeof import("./events")>("./events");
  return {
    ...actual,
    emitWith: (name: string, detail: { path: string; line?: number }) => {
      if (name === actual.OPEN_IN_EDITOR) opened.push(detail);
    },
  };
});

function bodyFor(command: string): unknown {
  if (command === "initialize") return { supportsConfigurationDoneRequest: true };
  if (command === "stackTrace") return { stackFrames: frames };
  if (command === "threads") return { threads: [{ id: 7, name: "main" }] };
  if (command === "source") return { content: sourceContent };
  return {};
}

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function freshModules() {
  vi.resetModules();
  const sessions = await import("./dapSessions");
  const stack = await import("./debugStack");
  return { sessions, stack };
}

const WS = "/p";
const FILE = "/p/src/index.ts";

const start = {
  adapterId: "js-debug",
  filePath: FILE,
  projectPath: WS,
  config: { type: "pwa-node", request: "launch", program: FILE },
};

const FILE_FRAMES = [
  { id: 1, name: "total", source: { path: FILE, name: "index.ts" }, line: 6, column: 3 },
  { id: 2, name: "(anonymous)", source: { path: FILE, name: "index.ts" }, line: 8, column: 1 },
];

const commands = (name: string) => sent.filter((s) => s.command === name);

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  opened.length = 0;
  sessionCounter = 0;
  frames = FILE_FRAMES;
  sourceContent = "export const bundled = 1;\n";
  failCommands.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

/** A run stopped at a breakpoint, which is the state everything here is about. */
async function paused() {
  const { sessions, stack } = await freshModules();
  const root = await sessions.startDebugSession(start);
  await flush();
  event(root!.handle.session, "stopped", { reason: "breakpoint", threadId: 3 });
  await flush();
  return { sessions, stack, id: root!.handle.session };
}

describe("what a pause records", () => {
  it("asks for the stack and keeps the frames", async () => {
    const { stack, id } = await paused();

    expect(stack.debugPaused()).toBe(true);
    const stop = stack.debugStops()[0];
    expect(stop).toMatchObject({ id, threadId: 3, reason: "breakpoint" });
    expect(stop.frames.map((f) => `${f.name}@${f.line}`)).toEqual(["total@6", "(anonymous)@8"]);
    // The thread comes from the event, never from a constant: Phase 1 measured
    // it differing per session (0 in a launch, 2 in a vitest worker).
    expect(commands("stackTrace")[0].args).toMatchObject({ threadId: 3, startFrame: 0 });
  });

  it("never surfaces the entry pause", async () => {
    const { sessions, stack } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();

    event(root!.handle.session, "stopped", { reason: "entry", threadId: 1 });
    await flush();

    // Sway asked for that one itself so a source map has time to resolve, and
    // continues straight through it. A stack for it would flash a frame nobody
    // asked to see at the start of every launch.
    expect(stack.debugPaused()).toBe(false);
    expect(commands("stackTrace")).toEqual([]);
  });

  it("selects the top frame and opens where it is", async () => {
    const { stack, id } = await paused();

    // The first thing anyone wants from a breakpoint is to be looking at it.
    expect(stack.selectedFrame()).toEqual({ session: id, frameId: 1 });
    expect(opened).toEqual([{ path: FILE, line: 6 }]);
    expect(stack.frameLocation()).toEqual({ path: FILE, line: 6 });
  });

  it("leaves the editor alone when a second session stops", async () => {
    const { sessions, stack, id } = await paused();
    const root = sessions.debugSession(id)!;
    deliver(id, {
      seq: 500,
      type: "request",
      command: "startDebugging",
      arguments: { configuration: { __pendingTargetId: "t1" }, request: "launch" },
    });
    await flush();
    const child = root.children[0];
    opened.length = 0;

    frames = [{ id: 9, name: "worker", source: { path: "/p/src/w.ts", name: "w.ts" }, line: 2 }];
    event(child, "stopped", { reason: "breakpoint", threadId: 5 });
    await flush();

    // Both pauses are listed, but several workers hitting one breakpoint would
    // otherwise take turns yanking the editor to whichever answered last.
    expect(stack.debugStops().map((s) => s.id)).toEqual([id, child]);
    expect(stack.selectedFrame()).toEqual({ session: id, frameId: 1 });
    expect(opened).toEqual([]);
  });

  it("survives an adapter that will not answer stackTrace", async () => {
    failCommands.add("stackTrace");
    const { stack } = await paused();

    // The pause is real even when the stack is not: saying "paused, no frames"
    // beats showing nothing at all and looking like it is still running.
    expect(stack.debugPaused()).toBe(true);
    expect(stack.debugStops()[0].frames).toEqual([]);
  });
});

describe("the controls", () => {
  it("are shut while the program runs", async () => {
    const { sessions, stack } = await freshModules();
    await sessions.startDebugSession(start);
    await flush();

    expect(stack.debugPaused()).toBe(false);
    // Stepping a running program is not a thing DAP can do, so the pane gates
    // on exactly this.
    stack.stepOver();
    stack.stepIn();
    stack.stepOut();
    stack.continueDebug();
    await flush();
    expect(commands("next")).toEqual([]);
    expect(commands("stepIn")).toEqual([]);
    expect(commands("stepOut")).toEqual([]);
    expect(commands("continue")).toEqual([]);
  });

  it("send the paused session's thread", async () => {
    const { stack, id } = await paused();
    sent.length = 0;

    stack.stepOver();
    await flush();

    expect(commands("next")).toEqual([{ session: id, command: "next", args: { threadId: 3 } }]);
  });

  it("clear the stack the moment one is sent", async () => {
    const { stack } = await paused();
    stack.continueDebug();

    // Not on the adapter's answer: a step's own `stopped` can arrive before the
    // `continued` event, and a stack left standing in between is a highlight on
    // a line the program has left.
    expect(stack.debugPaused()).toBe(false);
    expect(stack.frameLocation()).toBeNull();
  });

  it("put it back when the adapter refuses the step", async () => {
    const { stack } = await paused();
    failCommands.add("next");

    stack.stepOver();
    expect(stack.debugPaused()).toBe(false);
    await flush();

    // Refused means the program never moved, so it is still paused exactly
    // where it was. Left cleared, the pane would arm pause and shut every step
    // against a program that is going nowhere.
    expect(stack.debugPaused()).toBe(true);
    expect(stack.frameLocation()).toEqual({ path: FILE, line: 6 });
  });

  it("leave a newer stop alone when an older step is refused", async () => {
    const { stack, id } = await paused();
    failCommands.add("next");
    stack.stepOver();
    frames = [{ id: 8, name: "later", source: { path: FILE, name: "index.ts" }, line: 30 }];
    event(id, "stopped", { reason: "step", threadId: 3 });
    await flush();

    // The refusal is the older news. Restoring over the top of it would move the
    // reader back to a line the program has left.
    expect(stack.debugStops()).toHaveLength(1);
    expect(stack.debugStops()[0].frames[0].line).toBe(30);
  });

  it("pause the leaves, since the root never stops", async () => {
    const { sessions } = await freshModules();
    const stack = await import("./debugStack");
    const root = await sessions.startDebugSession(start);
    await flush();
    deliver(root!.handle.session, {
      seq: 500,
      type: "request",
      command: "startDebugging",
      arguments: { configuration: { __pendingTargetId: "t1" }, request: "launch" },
    });
    await flush();
    sent.length = 0;

    stack.pauseDebug();
    await flush();

    // Phase 1 measured the root session never stopping; the leaves are where
    // program code runs. And the thread has to be asked for, because nothing
    // has told us one yet.
    expect(commands("threads").map((c) => c.session)).toEqual(["sess1"]);
    expect(commands("pause")).toEqual([{ session: "sess1", command: "pause", args: { threadId: 7 } }]);
  });
});

describe("when the pause ends", () => {
  it("drops the stack on continued", async () => {
    const { stack, id } = await paused();
    event(id, "continued", { threadId: 3 });

    expect(stack.debugPaused()).toBe(false);
    expect(stack.selectedFrame()).toBeNull();
    expect(stack.frameLocation()).toBeNull();
  });

  it("drops it on terminated", async () => {
    const { stack, id } = await paused();
    event(id, "terminated");
    await flush();

    expect(stack.debugStops()).toEqual([]);
  });

  it("drops it when the whole tree goes", async () => {
    const { sessions, stack } = await paused();
    await sessions.stopAllDap();
    await flush();

    // A project switch sweeps every run at once, without any session getting to
    // say `terminated` first.
    expect(stack.debugStops()).toEqual([]);
    expect(stack.selectedFrame()).toBeNull();
  });
});

describe("a frame with no file on disk", () => {
  const BUNDLED = [
    { id: 4, name: "require", source: { name: "node:internal/modules", sourceReference: 12 }, line: 3 },
  ];

  it("fetches the source and opens it as a tab of its own", async () => {
    frames = BUNDLED;
    const { stack } = await paused();

    // There is no path any editor could read, so the content comes back by
    // reference and opens read-only.
    expect(commands("source")[0].args).toMatchObject({ sourceReference: 12 });
    expect(opened).toHaveLength(1);
    expect(opened[0].path).toContain("sway://dapsource/");
    expect(opened[0].line).toBe(3);
    expect(stack.debugSourceText(opened[0].path)).toBe(sourceContent);
    // And no line highlight in any buffer: the fetched view draws its own.
    expect(stack.frameLocation()).toBeNull();
  });

  it("keys the tab on the session, not on the reference alone", async () => {
    frames = BUNDLED;
    const { id } = await paused();

    // Two runs hand out the same small reference numbers for different code, so
    // a tab keyed on the number alone would show one run's source under
    // another's name.
    expect(opened[0].path).toContain(encodeURIComponent(`${id}:12:`));
  });

  it("takes the reference over the path when a frame carries both", async () => {
    frames = [
      {
        id: 5,
        name: "load",
        source: {
          // Measured: js-debug sends node's own frames exactly like this, a
          // path that has never existed on any disk beside a live reference.
          path: "<node_internals>/internal/modules/cjs/loader",
          name: "<node_internals>/internal/modules/cjs/loader",
          sourceReference: 720072378,
        },
        line: 1781,
      },
    ];
    const { stack } = await paused();

    // DAP's own rule, not a preference: a source with a reference must be
    // fetched through the `source` request even when a path is given. Reading
    // the path first opens a tab on a file that cannot be read.
    expect(commands("source")[0].args).toMatchObject({ sourceReference: 720072378 });
    expect(opened[0].path).toContain("sway://dapsource/");
    expect(stack.frameLocation()).toBeNull();
  });

  it("names which tab the paused line belongs in", async () => {
    frames = BUNDLED;
    const { stack } = await paused();

    // "The current frame has no file" is true in every fetched-source tab at
    // once, so the id is what stops a second one drawing the stripe on a line
    // that means nothing in it.
    expect(stack.currentSourceTab()).toBe(opened[0].path);
    expect(stack.currentSourceTab()).not.toBe(null);
  });

  it("names no tab for a frame that is in a real file", async () => {
    const { stack } = await paused();
    expect(stack.currentSourceTab()).toBeNull();
  });

  it("opens nothing when the adapter refuses the source", async () => {
    frames = BUNDLED;
    failCommands.add("source");
    const { stack } = await paused();

    // Better than an empty tab titled after code nobody can read.
    expect(opened).toEqual([]);
    expect(stack.debugStops()[0].frames[0].sourceReference).toBe(12);
  });
});
