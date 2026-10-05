import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

// What the paused program holds.
//
// Driven through the real `dapSessions` and `debugStack` against a fake
// adapter, so the requests asserted are the ones that would go out: which
// reference is asked for, with which page, and what a refusal does. The pane's
// rendering of the same state is tested separately.

type Handle = { server: string; session: string };
type Sent = { command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
let sessionCounter = 0;
/** What `initialize` answers with, so a test can withhold a capability. */
let capabilities: Record<string, unknown> = {
  supportsConfigurationDoneRequest: true,
  supportsSetVariable: true,
};
/** What `scopes` answers with. */
let scopeList: unknown[] = [];
/** Keyed by `${variablesReference}:${filter ?? ""}`, so one container can answer
 *  differently for its named and its indexed halves. */
let variableAnswers = new Map<string, unknown[]>();
/** What `setVariable` answers. Deliberately *not* applied to the container the
 *  fake serves: measured against js-debug 1.117, a scope's container is a
 *  snapshot of the pause and still reports the old value after a write that
 *  `evaluate` confirms took. The response is the only fresh reading there is. */
let setResult: { value: string; variablesReference?: number } = { value: "42" };
/** What `evaluate` answers with. */
let evaluateAnswer: unknown = { result: "7", type: "number" };
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
            ...(failed ? { message: `${command} refused` } : {}),
            body: bodyFor(command, requestArgs),
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

function bodyFor(command: string, args: Record<string, unknown>): unknown {
  if (command === "initialize") return capabilities;
  if (command === "threads") return { threads: [{ id: 3, name: "main" }] };
  if (command === "stackTrace") return { stackFrames: FRAMES };
  if (command === "scopes") return { scopes: scopeList };
  if (command === "variables") {
    const key = `${args.variablesReference}:${(args.filter as string) ?? ""}`;
    return { variables: variableAnswers.get(key) ?? [] };
  }
  if (command === "setVariable") {
    void args;
    return { value: setResult.value, variablesReference: setResult.variablesReference ?? 0 };
  }
  if (command === "evaluate") return evaluateAnswer;
  return {};
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
  { id: 11, name: "total", source: { path: FILE, name: "index.ts" }, line: 6, column: 3 },
  { id: 12, name: "main", source: { path: FILE, name: "index.ts" }, line: 9, column: 1 },
];

const SCOPES = [
  { name: "Locals", variablesReference: 100, expensive: false },
  { name: "Global", variablesReference: 200, expensive: true },
];

const commands = (name: string) => sent.filter((s) => s.command === name);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  sessionCounter = 0;
  capabilities = { supportsConfigurationDoneRequest: true, supportsSetVariable: true };
  scopeList = SCOPES;
  variableAnswers = new Map<string, unknown[]>([
    [
      "100:",
      [
        { name: "count", value: "3", type: "number", variablesReference: 0 },
        { name: "user", value: "Object", type: "object", variablesReference: 300 },
      ],
    ],
    ["300:", [{ name: "id", value: "'u1'", type: "string", variablesReference: 0 }]],
  ]);
  setResult = { value: "42" };
  evaluateAnswer = { result: "7", type: "number" };
  failCommands.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

async function freshModules() {
  vi.resetModules();
  const sessions = await import("./dapSessions");
  const stack = await import("./debugStack");
  const vars = await import("./debugVariables");
  return { sessions, stack, vars };
}

/** A run stopped at a breakpoint with its top frame selected, which is the only
 *  state anything here has anything to say about. */
async function paused() {
  const mods = await freshModules();
  const root = await mods.sessions.startDebugSession(start);
  await flush();
  event(root!.handle.session, "stopped", { reason: "breakpoint", threadId: 3 });
  await flush();
  return { ...mods, id: root!.handle.session };
}

describe("what a pause fetches", () => {
  it("asks for the selected frame's scopes and nothing under them", async () => {
    const { vars } = await paused();

    expect(commands("scopes").map((c) => c.args.frameId)).toEqual([11]);
    expect(vars.debugScopes().map((s) => s.name)).toEqual(["Locals", "Global"]);
    // The whole point of the lazy tree: a pause in a test worker has a Global
    // scope of thousands of entries, and none of it is on screen yet.
    expect(commands("variables")).toEqual([]);
  });

  it("passes on the adapter's own expensive warning", async () => {
    const { vars } = await paused();
    expect(vars.debugScopes().map((s) => s.expensive)).toEqual([false, true]);
  });

  it("fetches a scope's children only when it is expanded", async () => {
    const { vars } = await paused();

    vars.toggleVariables("s0", 100);
    await flush();

    expect(commands("variables").map((c) => c.args.variablesReference)).toEqual([100]);
    expect(vars.variableRows("s0").map((r) => `${r.name}=${r.value}`)).toEqual(["count=3", "user=Object"]);
    expect(vars.isVariableExpanded("s0")).toBe(true);
  });

  it("does not re-ask for children it already has", async () => {
    const { vars } = await paused();

    vars.toggleVariables("s0", 100);
    await flush();
    vars.toggleVariables("s0", 100);
    vars.toggleVariables("s0", 100);
    await flush();

    expect(commands("variables")).toHaveLength(1);
    expect(vars.isVariableExpanded("s0")).toBe(true);
  });

  it("expands a nested object under its own key", async () => {
    const { vars } = await paused();

    vars.toggleVariables("s0", 100);
    await flush();
    const user = vars.variableRows("s0")[1];
    vars.toggleVariables(user.key, user.variablesReference);
    await flush();

    expect(vars.variableRows(user.key).map((r) => r.name)).toEqual(["id"]);
    // The container a `setVariable` would be addressed to, which is the parent
    // rather than the row itself.
    expect(vars.variableRows(user.key)[0].parentReference).toBe(300);
  });
});

describe("a container too long to ask for at once", () => {
  const LONG = 1000;

  beforeEach(() => {
    variableAnswers.set("100:", [
      { name: "rows", value: "Array(1000)", variablesReference: 400, indexedVariables: LONG },
    ]);
    variableAnswers.set("400:named", [{ name: "length", value: "1000", variablesReference: 0 }]);
    variableAnswers.set(
      "400:indexed",
      Array.from({ length: 100 }, (_, i) => ({ name: String(i), value: `e${i}`, variablesReference: 0 })),
    );
  });

  it("asks for a page rather than for everything", async () => {
    const { vars } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();
    const rows = vars.variableRows("s0")[0];

    vars.toggleVariables(rows.key, rows.variablesReference, rows.indexedVariables);
    await flush();

    const asked = commands("variables").filter((c) => c.args.variablesReference === 400);
    expect(asked.map((c) => c.args.filter)).toEqual(["named", "indexed"]);
    expect(asked[1].args).toMatchObject({ start: 0, count: vars.VARIABLE_PAGE });
    // Named children come with it, because a `filter: "indexed"` answer has no
    // `length` in it and that is the one property anyone reads off a long array.
    expect(vars.variableRows(rows.key)[0].name).toBe("length");
    expect(vars.variableRows(rows.key)).toHaveLength(101);
    expect(vars.variableMore(rows.key)).toBe(LONG - vars.VARIABLE_PAGE);
  });

  it("takes the next page from where the last one ended", async () => {
    const { vars } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();
    const rows = vars.variableRows("s0")[0];
    vars.toggleVariables(rows.key, rows.variablesReference, rows.indexedVariables);
    await flush();

    await vars.loadMoreVariables(rows.key);
    await flush();

    const pages = commands("variables").filter((c) => c.args.filter === "indexed");
    expect(pages.map((c) => c.args.start)).toEqual([0, 100]);
    expect(vars.variableRows(rows.key)).toHaveLength(201);
    expect(vars.variableMore(rows.key)).toBe(800);
  });

  it("says nothing is left for a container that fits in one page", async () => {
    const { vars } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();

    expect(vars.variableMore("s0")).toBe(0);
    expect(commands("variables").every((c) => c.args.filter === undefined)).toBe(true);
  });
});

describe("the tree belongs to one frame", () => {
  it("drops everything and re-asks when another frame is selected", async () => {
    const { vars, stack, id } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();
    expect(vars.variableRows("s0")).toHaveLength(2);

    stack.selectFrame(id, 12);
    await flush();

    // A reference belongs to the frame it was handed out for, so keeping the
    // rows would show the caller's locals under the callee's name.
    expect(vars.variableRows("s0")).toEqual([]);
    expect(vars.isVariableExpanded("s0")).toBe(false);
    expect(commands("scopes").map((c) => c.args.frameId)).toEqual([11, 12]);
  });

  it("clears itself when the program continues", async () => {
    const { vars, stack } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();

    stack.continueDebug();
    await flush();

    expect(vars.debugScopes()).toEqual([]);
    expect(vars.variableRows("s0")).toEqual([]);
  });

  it("ignores an answer that arrives for a frame that is gone", async () => {
    const { vars, stack, id } = await paused();
    // Expand, then switch frames before the answer can land.
    vars.toggleVariables("s0", 100);
    stack.selectFrame(id, 12);
    await flush();

    expect(vars.variableRows("s0")).toEqual([]);
    expect(vars.isVariablesBusy("s0")).toBe(false);
  });

  it("leaves no page count behind from an answer for a frame that is gone", async () => {
    variableAnswers.set("100:", [
      { name: "rows", value: "Array(1000)", variablesReference: 400, indexedVariables: 1000 },
    ]);
    variableAnswers.set("400:named", [{ name: "length", value: "1000", variablesReference: 0 }]);
    variableAnswers.set("400:indexed", [{ name: "0", value: "e0", variablesReference: 0 }]);
    const { vars, stack, id } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();
    const rows = vars.variableRows("s0")[0];

    vars.toggleVariables(rows.key, rows.variablesReference, rows.indexedVariables);
    stack.selectFrame(id, 12);
    await flush();

    // Keys are built from position, so the next frame produces this same key.
    // A page count recorded by the dead answer would draw "Show 100 more of
    // 900" over children the new frame never fetched.
    expect(vars.variableMore(rows.key)).toBe(0);
    expect(vars.variableRows(rows.key)).toEqual([]);
  });
});

describe("writing a value back", () => {
  it("is offered only when the adapter serves it", async () => {
    const { vars } = await paused();
    expect(vars.canSetVariable()).toBe(true);

    capabilities = { supportsConfigurationDoneRequest: true };
    const again = await paused();
    expect(again.vars.canSetVariable()).toBe(false);
  });

  it("names the container rather than the variable, and shows what came back", async () => {
    const { vars } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();
    const count = vars.variableRows("s0")[0];

    const failure = await vars.setVariableValue(count, "42");
    await flush();

    expect(failure).toBeNull();
    expect(commands("setVariable")[0].args).toMatchObject({
      variablesReference: 100,
      name: "count",
      value: "42",
    });
    // The adapter's value, not the typed one: `1+1` is a valid expression and
    // the answer is what the variable now holds.
    expect(vars.variableRows("s0")[0].value).toBe("42");
  });

  it("returns the adapter's refusal and leaves the old value standing", async () => {
    failCommands.add("setVariable");
    const { vars } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();
    const count = vars.variableRows("s0")[0];

    const failure = await vars.setVariableValue(count, "nope");
    await flush();

    expect(failure).toContain("setVariable refused");
    expect(vars.variableRows("s0")[0].value).toBe("3");
  });

  it("does not re-read the container, which would answer the pre-write value", async () => {
    const { vars } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();
    const before = commands("variables").filter((c) => c.args.variablesReference === 100).length;

    await vars.setVariableValue(vars.variableRows("s0")[0], "42");
    await flush();

    // Measured against js-debug 1.117: a scope's container is a snapshot of the
    // pause. After a write that `evaluate` confirms took (`count` -> 42) the
    // container still answers 3, and so does a fresh `scopes` request, so
    // re-reading would replace a correct value with a stale one.
    const after = commands("variables").filter((c) => c.args.variablesReference === 100).length;
    expect(after).toBe(before);
    expect(vars.variableRows("s0")[0].value).toBe("42");
  });

  it("drops the children of a value that was replaced", async () => {
    const { vars } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();
    const user = vars.variableRows("s0")[1];
    vars.toggleVariables(user.key, user.variablesReference);
    await flush();
    expect(vars.variableRows(user.key)).toHaveLength(1);

    setResult = { value: "null" };
    await vars.setVariableValue(user, "null");
    await flush();

    // Whatever it held is gone, so its children describe an object that no
    // longer exists.
    expect(vars.variableRows(user.key)).toEqual([]);
  });
});

describe("text the debuggee wrote", () => {
  it("renders a value's control bytes as characters", async () => {
    variableAnswers.set("100:", [{ name: "banner", value: "loud\u001b[31m\u0007", variablesReference: 0 }]);
    const { vars } = await paused();
    vars.toggleVariables("s0", 100);
    await flush();

    // A value is whatever the debuggee's own `toString` returned, which is the
    // class of text [[lesson_sanitize_text_you_did_not_author]] is about.
    expect(vars.variableRows("s0")[0].value).toBe("loud[31m");
  });

  it("does the same for an evaluated result", async () => {
    evaluateAnswer = { result: "a\u0000b", type: "string" };
    const { vars } = await paused();

    expect((await vars.evaluateInFrame("x"))?.value).toBe("ab");
  });
});

describe("evaluating one expression", () => {
  it("asks in the selected frame", async () => {
    const { vars } = await paused();

    const answer = await vars.evaluateInFrame("user.id");

    expect(answer).toEqual({ value: "7", type: "number" });
    expect(commands("evaluate")[0].args).toMatchObject({
      expression: "user.id",
      frameId: 11,
      context: "hover",
    });
  });

  it("answers nothing while the program is running", async () => {
    const { vars, stack } = await paused();
    stack.continueDebug();
    await flush();

    expect(await vars.evaluateInFrame("count")).toBeNull();
    expect(commands("evaluate")).toEqual([]);
  });

  it("answers nothing for a name the adapter refuses, without complaining", async () => {
    failCommands.add("evaluate");
    const { vars } = await paused();

    expect(await vars.evaluateInFrame("notAName")).toBeNull();
    // A word that is not in scope is the normal case for a hover, so it is not
    // worth a console line per pointer movement. (Filtered rather than asserted
    // empty: `vi.resetModules()` makes Solid warn about itself once per file.)
    const ours = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("evaluate"));
    expect(ours).toEqual([]);
  });
});
