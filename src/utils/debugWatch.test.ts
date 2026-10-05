import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

// What a watch is worth, and what a REPL entry does.
//
// Both driven through the real `dapSessions` and `debugStack` against a fake
// adapter, so the requests asserted are the ones that would go out. The list
// rules live in `watches.ts` and are tested with no adapter at all.

type Handle = { server: string; session: string };
type Sent = { session: string; command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
let sessionCounter = 0;
/** Answers keyed by expression, so one run can resolve some and refuse others. */
let evaluations = new Map<string, { result?: string; type?: string; fail?: string }>();

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
        const command = frame.command as string;
        const requestArgs = (frame.arguments ?? {}) as Record<string, unknown>;
        sent.push({ session: handle.session, command, args: requestArgs });
        const answer =
          command === "evaluate"
            ? evaluations.get(requestArgs.expression as string)
            : undefined;
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
    }
    return Promise.resolve();
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));

vi.mock("./events", async () => {
  const actual = await vi.importActual<typeof import("./events")>("./events");
  return { ...actual, emitWith: () => {} };
});

function bodyFor(command: string, answer?: { result?: string; type?: string }): unknown {
  if (command === "initialize")
    return { supportsConfigurationDoneRequest: true, supportsSetVariable: true };
  if (command === "stackTrace") return { stackFrames: FRAMES };
  if (command === "scopes") return { scopes: [{ name: "Locals", variablesReference: 100 }] };
  if (command === "variables")
    return { variables: [{ name: "count", value: "3", variablesReference: 0 }] };
  if (command === "setVariable") return { value: "42", variablesReference: 0 };
  if (command === "evaluate") return { result: answer?.result ?? "?", type: answer?.type };
  return {};
}

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const WS = "/p";
const FILE = "/p/src/index.ts";

const start = {
  adapterId: "js-debug",
  childSessions: true,
  filePath: FILE,
  projectPath: WS,
  config: { type: "pwa-node", request: "launch", program: FILE },
};

const FRAMES = [
  { id: 11, name: "total", source: { path: FILE, name: "index.ts" }, line: 6 },
  { id: 12, name: "main", source: { path: FILE, name: "index.ts" }, line: 9 },
];

const commands = (name: string) => sent.filter((s) => s.command === name);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  sessionCounter = 0;
  evaluations = new Map([
    ["count", { result: "3", type: "number" }],
    ["user.name", { result: "'Ada'", type: "string" }],
    ["nope", { fail: "nope is not defined" }],
  ]);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

async function freshModules() {
  vi.resetModules();
  const sessions = await import("./dapSessions");
  const stack = await import("./debugStack");
  const watch = await import("./debugWatch");
  const repl = await import("./debugRepl");
  const store = await import("./debugStore");
  const vars = await import("./debugVariables");
  return { sessions, stack, watch, repl, store, vars };
}

/** A live run, not yet paused. */
async function running() {
  const mods = await freshModules();
  const root = await mods.sessions.startDebugSession(start);
  await flush();
  return { ...mods, id: root!.handle.session };
}

/** A run stopped at a breakpoint, with its top frame selected. */
async function paused() {
  const mods = await running();
  event(mods.id, "stopped", { reason: "breakpoint", threadId: 3 });
  await flush();
  return mods;
}

describe("what a watch answers", () => {
  it("evaluates a new expression at once rather than waiting for the next step", async () => {
    const { watch } = await paused();

    watch.addWatchExpression(WS, "count");
    await flush();

    // A watch that stays blank until the next step reads as broken.
    expect(watch.watchRows(WS)).toEqual([
      { expression: "count", value: "3", type: "number", error: null, pending: false },
    ]);
    expect(commands("evaluate")[0].args).toMatchObject({
      expression: "count",
      frameId: 11,
      context: "watch",
    });
  });

  it("re-reads every watch on every stop", async () => {
    const { watch, stack, id } = await paused();
    watch.addWatchExpression(WS, "count");
    watch.addWatchExpression(WS, "user.name");
    await flush();
    const before = commands("evaluate").length;

    // A step is a continue and a new stop, which is what re-reading hangs off.
    stack.stepOver();
    await flush();
    event(id, "stopped", { reason: "step", threadId: 3 });
    await flush();

    const asked = commands("evaluate").slice(before);
    expect(asked.map((c) => c.args.expression)).toEqual(["count", "user.name"]);
    expect(watch.watchRows(WS).map((r) => r.value)).toEqual(["3", "'Ada'"]);
  });

  it("shows the adapter's message and keeps the row", async () => {
    const { watch } = await paused();

    watch.addWatchExpression(WS, "nope");
    await flush();

    // A watch that vanishes when it errors is one nobody can fix, because there
    // is nothing left to click.
    const row = watch.watchRows(WS)[0];
    expect(row.expression).toBe("nope");
    expect(row.error).toContain("nope is not defined");
    expect(row.value).toBeNull();
  });

  it("holds no value while the program is running", async () => {
    const { watch, stack } = await paused();
    watch.addWatchExpression(WS, "count");
    await flush();
    expect(watch.watchRows(WS)[0].value).toBe("3");

    stack.continueDebug();
    await flush();

    // Keeping it would show the value from two steps ago as if it were current.
    expect(watch.watchRows(WS)[0].value).toBeNull();
    expect(watch.watchesLive()).toBe(false);
  });

  it("re-reads against the frame that is selected, not the one that stopped", async () => {
    const { watch, stack, id } = await paused();
    watch.addWatchExpression(WS, "count");
    await flush();
    const before = commands("evaluate").length;

    stack.selectFrame(id, 12);
    await flush();

    expect(commands("evaluate").slice(before)[0].args).toMatchObject({
      expression: "count",
      frameId: 12,
    });
  });

  it("forgets a removed expression's answer", async () => {
    const { watch } = await paused();
    watch.addWatchExpression(WS, "count");
    await flush();

    watch.removeWatchExpression(WS, 0);
    watch.addWatchExpression(WS, "count");

    // Re-added, so it is pending rather than showing the answer from before it
    // was removed.
    expect(watch.watchRows(WS)[0].value).toBeNull();
  });

  it("does not answer another workspace's expression against this frame", async () => {
    const { watch } = await paused();

    watch.addWatchExpression("/elsewhere", "count");
    await flush();

    // The frame belongs to one project, and `count` means something else in
    // another one. Answering anyway would be worse than staying blank.
    expect(commands("evaluate")).toEqual([]);
    expect(watch.watchRows("/elsewhere")[0].value).toBeNull();
  });

  it("keeps two workspaces' answers apart even for identical text", async () => {
    const { watch } = await paused();
    watch.addWatchExpression(WS, "count");
    watch.addWatchExpression("/elsewhere", "count");
    await flush();

    expect(watch.watchRows(WS)[0].value).toBe("3");
    expect(watch.watchRows("/elsewhere")[0].value).toBeNull();
  });

  it("re-reads after a variable is written, which has no event of its own", async () => {
    const { watch, vars } = await paused();
    watch.addWatchExpression(WS, "count");
    await flush();
    vars.toggleVariables("s0", 100);
    await flush();
    const before = commands("evaluate").length;

    await vars.setVariableValue(vars.variableRows("s0")[0], "42");
    await flush();

    // Phase 8 measured that a scope's container still reports the pre-write
    // value while `evaluate` answers the truth, so this is exactly when a watch
    // is most out of date and nothing else would say so.
    expect(commands("evaluate").length).toBe(before + 1);
  });

  it("asks nothing when nothing is paused", async () => {
    const { watch } = await running();

    watch.addWatchExpression(WS, "count");
    await flush();

    expect(commands("evaluate")).toEqual([]);
    expect(watch.watchRows(WS)[0]).toMatchObject({ value: null, error: null, pending: false });
  });
});

describe("the console's input", () => {
  it("echoes what was typed and prints what came back", async () => {
    const { repl, store } = await paused();

    await repl.evaluateRepl("count");
    await flush();

    expect(store.consoleLines().map((l) => l.text)).toEqual(["> count", "3"]);
    expect(store.consoleLines().every((l) => l.category === "repl")).toBe(true);
    expect(commands("evaluate")[0].args).toMatchObject({
      expression: "count",
      frameId: 11,
      context: "repl",
    });
  });

  it("evaluates against the running program when nothing is paused", async () => {
    const { repl, store } = await running();

    await repl.evaluateRepl("count");
    await flush();

    // No frame exists, so none is named: DAP's own way of saying "the global
    // scope" rather than a frame id that would not resolve.
    expect(commands("evaluate")[0].args).toMatchObject({ expression: "count", context: "repl" });
    expect(commands("evaluate")[0].args.frameId).toBeUndefined();
    expect(store.consoleLines().map((l) => l.text)).toEqual(["> count", "3"]);
  });

  it("says so rather than hanging when there is no session", async () => {
    const { repl, store, sessions } = await freshModules();
    expect(sessions.debugRoots()).toEqual([]);

    await repl.evaluateRepl("count");

    expect(store.consoleLines().map((l) => l.text)).toEqual([
      "> count",
      "No debug session. Start one with F5 to evaluate here.",
    ]);
    expect(commands("evaluate")).toEqual([]);
  });

  it("prints a refusal rather than swallowing it", async () => {
    const { repl, store } = await paused();

    await repl.evaluateRepl("nope");
    await flush();

    // A REPL that swallows its own errors is one where a typo and a null are
    // the same answer.
    expect(store.consoleLines()[1].text).toContain("nope is not defined");
  });

  it("names the session that answered, so a surprising value can be traced", async () => {
    const { repl, store } = await paused();

    await repl.evaluateRepl("count");
    await flush();

    // A run is many sessions and an unpaused entry goes to one of them, so the
    // answer says which rather than appearing from nowhere.
    const answer = store.consoleLines()[1];
    expect(answer.sessionName).toBeTruthy();
    expect(answer.sessionName).not.toBe("you");
  });

  it("remembers what was entered, so it can be walked back through", async () => {
    const { repl } = await paused();

    await repl.evaluateRepl("count");
    await repl.evaluateRepl("count");
    await repl.evaluateRepl("user.name");
    await flush();

    // A repeat of the line immediately above adds nothing to walk back through.
    expect(repl.replHistory()).toEqual(["count", "user.name"]);
  });

  it("ignores a blank entry entirely", async () => {
    const { repl, store } = await paused();

    await repl.evaluateRepl("   ");

    expect(store.consoleLines()).toEqual([]);
  });

  it("is never silent on an empty answer", async () => {
    evaluations.set("side()", { result: "" });
    const { repl, store } = await paused();

    await repl.evaluateRepl("side()");
    await flush();

    // A REPL that prints nothing on success reads as one that hung.
    expect(store.consoleLines()[1].text).toBe("(no value)");
  });
});
