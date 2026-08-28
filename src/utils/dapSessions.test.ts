import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import editorSource from "../panels/Editor/Editor.tsx?raw";

// The session tree and the orchestration around it. Everything below the module
// is a fake adapter: what is asserted here is the shape of the tree, that a
// session configures exactly once, and that a start which loses its project
// takes itself down rather than leaving a debuggee running for a project nobody
// has open.

type Handle = { server: string; session: string };

type Invoke = { cmd: string; args: Record<string, unknown> };

const calls: Invoke[] = [];
/** Every frame the module wrote, by session id. */
const sends = new Map<string, Record<string, unknown>[]>();
/** The Channel each session was opened with, so a test can push frames in. */
const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();

let serverCounter = 0;
let sessionCounter = 0;
/** When set, `dap_start` blocks on this, so a teardown can be interleaved with
 *  a start that is already in flight. */
let holdStart: Promise<void> | null = null;
let startFails = false;

/** Bodies the fake adapter answers requests with. Anything not here answers
 *  `{}`, which is what `configurationDone` and `launch` really answer. */
const bodies: Record<string, unknown> = {
  initialize: { supportsConfigurationDoneRequest: true },
  setBreakpoints: { breakpoints: [{ verified: false }] },
};

/** Commands the fake adapter answers `success: false` to. */
const failCommands = new Set<string>();

/** Commands the fake adapter never answers at all, so a request can still be in
 *  flight when something else happens to the session. */
const silentCommands = new Set<string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    if (cmd === "dap_start") {
      if (startFails) return Promise.reject(new Error("bundled adapter not found"));
      const handle: Handle = { server: `dap${serverCounter++}`, session: `sess${sessionCounter++}` };
      channels.set(handle.session, args!.onMessage as { onmessage: ((m: string) => void) | null });
      const result = Promise.resolve(handle);
      return holdStart ? holdStart.then(() => handle) : result;
    }
    if (cmd === "dap_connect") {
      const handle: Handle = { server: args!.server as string, session: `sess${sessionCounter++}` };
      channels.set(handle.session, args!.onMessage as { onmessage: ((m: string) => void) | null });
      return Promise.resolve(handle);
    }
    if (cmd === "dap_send") {
      const handle = args!.handle as Handle;
      const frame = JSON.parse(args!.message as string) as Record<string, unknown>;
      sends.set(handle.session, [...(sends.get(handle.session) ?? []), frame]);
      // The adapter answers every request. Asynchronously, as the real IPC does.
      if (frame.type === "request" && !silentCommands.has(frame.command as string)) {
        const failed = failCommands.has(frame.command as string);
        void Promise.resolve().then(() =>
          deliver(handle.session, {
            seq: 9000,
            type: "response",
            request_seq: frame.seq,
            command: frame.command,
            success: !failed,
            ...(failed ? { message: `${frame.command} refused` } : {}),
            body: failed ? {} : (bodies[frame.command as string] ?? {}),
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

/** Push one frame at a session, the way the backend's pump does. */
function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

/** Drive a `startDebugging` reverse request at `session`, as js-debug does for
 *  every target kind, and let the child's handshake settle. */
async function startDebugging(session: string, configuration: Record<string, unknown>): Promise<void> {
  deliver(session, {
    seq: 500,
    type: "request",
    command: "startDebugging",
    arguments: { configuration, request: "launch" },
  });
  await flush();
}

/** Let the fake adapter's replies and the handshakes they unblock settle. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function framesOf(session: string, command: string): Record<string, unknown>[] {
  return (sends.get(session) ?? []).filter((f) => f.command === command);
}

async function freshModule() {
  vi.resetModules();
  return import("./dapSessions");
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
  calls.length = 0;
  sends.clear();
  channels.clear();
  serverCounter = 0;
  sessionCounter = 0;
  holdStart = null;
  startFails = false;
  failCommands.clear();
  silentCommands.clear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("the session tree", () => {
  it("grows to arbitrary depth, one level per startDebugging", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    expect(root).not.toBeNull();
    await flush();

    // pnpm to node to vitest to worker: the shape Phase 1 measured for
    // `pnpm vitest`, and the reason this is a tree rather than a parent with a
    // list of children.
    await startDebugging(root!.handle.session, { type: "pwa-node", __pendingTargetId: "t1" });
    const child0 = root!.children[0];
    await startDebugging(child0, { type: "pwa-node", __pendingTargetId: "t2" });
    const child1 = m.debugSession(child0)!.children[0];
    await startDebugging(child1, { type: "pwa-node", __pendingTargetId: "t3" });

    expect(m.debugSessions()).toHaveLength(4);
    expect(m.debugSession(child1)!.children).toHaveLength(1);
    expect(m.debugRoots().map((s) => s.name)).toEqual(["run0"]);
    expect(m.debugSession(child1)!.name).toBe("run0.child0.child0");
  });

  it("takes every descendant with a terminated root, and stops the adapter", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();
    await startDebugging(root!.handle.session, { __pendingTargetId: "t1" });
    const child0 = root!.children[0];
    await startDebugging(child0, { __pendingTargetId: "t2" });
    expect(m.debugSessions()).toHaveLength(3);

    event(root!.handle.session, "terminated");
    await flush();

    expect(m.debugSessions()).toHaveLength(0);
    // The adapter process is what actually holds the debuggee: the backend
    // kills its whole process group, so nothing survives the root going away.
    expect(calls.filter((c) => c.cmd === "dap_stop")).toHaveLength(1);
  });

  it("takes a mid-tree session's own children with it, and leaves the rest", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();
    await startDebugging(root!.handle.session, { __pendingTargetId: "t1" });
    const child0 = root!.children[0];
    await startDebugging(child0, { __pendingTargetId: "t2" });
    const grandchild = m.debugSession(child0)!.children[0];

    event(child0, "terminated");
    await flush();

    expect(m.debugSession(child0)).toBeNull();
    expect(m.debugSession(grandchild)).toBeNull();
    expect(m.debugRoots()).toHaveLength(1);
    // The parent's child list no longer names a session that is gone, which is
    // what a pane walking the tree would otherwise render as a dead row.
    expect(m.debugSession(root!.handle.session)!.children).toEqual([]);
    // A child ending is not the run ending: the adapter stays up.
    expect(calls.filter((c) => c.cmd === "dap_stop")).toHaveLength(0);
  });

  it("notifies watchers when the tree changes", async () => {
    const m = await freshModule();
    let fired = 0;
    const off = m.onDebugChange(() => (fired += 1));
    const root = await m.startDebugSession(start);
    await flush();
    const afterStart = fired;
    expect(afterStart).toBeGreaterThan(0);

    event(root!.handle.session, "terminated");
    await flush();
    expect(fired).toBeGreaterThan(afterStart);
    off();
  });
});

describe("startDebugging", () => {
  it("opens a second connection to the same adapter and relays __pendingTargetId", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();

    await startDebugging(root!.handle.session, {
      type: "pwa-node",
      __pendingTargetId: "target-42",
      request: "attach",
    });

    // Not a second adapter: the same server id, which is the whole point of
    // splitting `dap_connect` out of `dap_start`.
    const connects = calls.filter((c) => c.cmd === "dap_connect");
    expect(connects).toHaveLength(1);
    expect(connects[0].args.server).toBe(root!.handle.server);

    const child = m.debugSession(root!.children[0])!;
    expect(child.parent).toBe(root!.handle.session);

    // The configuration is relayed verbatim. `__pendingTargetId` is the only
    // thing pairing this connection with the target js-debug is holding, so a
    // config rebuilt from known fields would attach to nothing.
    const attach = framesOf(child.handle.session, "attach")[0];
    expect(attach).toBeDefined();
    expect((attach.arguments as Record<string, unknown>).__pendingTargetId).toBe("target-42");
  });

  it("answers the adapter before the child is dialled", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();

    deliver(root!.handle.session, {
      seq: 500,
      type: "request",
      command: "startDebugging",
      arguments: { configuration: { __pendingTargetId: "t1" }, request: "launch" },
    });

    // Synchronously, with no await in between: js-debug is blocked on this
    // reply, and the child dials its own connection, so nothing about the
    // child's handshake depends on the answer being deferred.
    const reply = (sends.get(root!.handle.session) ?? []).find(
      (f) => f.type === "response" && f.command === "startDebugging",
    );
    expect(reply).toMatchObject({ request_seq: 500, success: true });
    await flush();
  });

  it("defaults a configuration with no request verb to launch", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();
    await startDebugging(root!.handle.session, { __pendingTargetId: "t1" });
    const child = m.debugSession(root!.children[0])!;
    expect(framesOf(child.handle.session, "launch")).toHaveLength(1);
  });
});

describe("the entry pause", () => {
  it("is continued straight through, and only that one", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();
    const id = root!.handle.session;

    // Launch configs ask for it so a source map has time to resolve before a
    // short-lived target exits; nobody asked to look at the first line.
    event(id, "stopped", { reason: "entry", threadId: 3 });
    await flush();
    const resumed = framesOf(id, "continue");
    expect(resumed).toHaveLength(1);
    // The thread from the event, never an assumed 1: Phase 1 measured 0 for a
    // launch and 2 for a vitest worker.
    expect((resumed[0].arguments as { threadId: number }).threadId).toBe(3);

    // A real stop is the user's, and continuing it would make breakpoints
    // useless in the most confusing possible way.
    event(id, "stopped", { reason: "breakpoint", threadId: 3 });
    await flush();
    expect(framesOf(id, "continue")).toHaveLength(1);
  });
});

describe("a failing launch", () => {
  it("tells the caller rather than only the console", async () => {
    const m = await freshModule();
    failCommands.add("attach");
    const failures: unknown[] = [];
    await m.startDebugSession({
      ...start,
      config: { request: "attach", port: 9229 },
      onLaunchFailed: (e) => failures.push(e),
    });
    await flush();

    // `handshake` cannot await the launch response without deadlocking against
    // its own `configurationDone`, so without this callback the one failure
    // people actually hit, attaching to a port nothing is listening on, would
    // reach a `console.warn` and nowhere else.
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("attach refused");
  });
});

describe("stopping a run mid-launch", () => {
  it("is not reported as a launch failure", async () => {
    const m = await freshModule();
    // Never answered, so the launch is genuinely still in flight when the stop
    // lands. Without this the fake would have answered it already and the test
    // would pass against the unfixed code.
    silentCommands.add("launch");
    const failures: unknown[] = [];
    const root = await m.startDebugSession({
      ...start,
      config: { request: "launch", program: "/p/a.ts" },
      onLaunchFailed: (e) => failures.push(e),
    });
    await flush();

    await m.stopDebugRun(root!.handle.session);
    await flush();

    // `dispose` rejects what was in flight, and answering a deliberate stop
    // with "could not start the debugger" is the wrong thing to say. A big run
    // makes it loud as well as wrong: a measured `pnpm test` had 214 sessions.
    expect(failures).toEqual([]);
  });
});

describe("configuring a session", () => {
  it("configures once even though js-debug emits initialized more than once", async () => {
    const m = await freshModule();
    m.setDebugBreakpointSource(() => new Map([["/p/src/index.ts", [6]]]));
    const root = await m.startDebugSession(start);
    await flush();
    const id = root!.handle.session;

    event(id, "initialized");
    await flush();
    event(id, "initialized");
    await flush();

    // Re-running the sequence re-sends `setBreakpoints`, which *replaces* that
    // file's set, and js-debug answers `[]` at that moment: the provisional
    // breakpoint the first pass registered is silently wiped, and the symptom
    // is a breakpoint that simply never fires with nothing logged anywhere.
    const sets = framesOf(id, "setBreakpoints");
    expect(sets).toHaveLength(1);
    expect((sets[0].arguments as { breakpoints: { line: number }[] }).breakpoints).toEqual([{ line: 6 }]);
    expect(framesOf(id, "configurationDone")).toHaveLength(1);
  });

  it("sends configurationDone even when a file's breakpoints are rejected", async () => {
    const m = await freshModule();
    failCommands.add("setBreakpoints");
    m.setDebugBreakpointSource(() => new Map([["/p/gone.ts", [1]]]));
    const root = await m.startDebugSession(start);
    await flush();
    const id = root!.handle.session;

    event(id, "initialized");
    await flush();

    // A file the adapter will not accept must not strand the handshake: without
    // `configurationDone` the launch never resolves and the run hangs at idle.
    expect(framesOf(id, "configurationDone")).toHaveLength(1);
  });

  it("handshakes with the pinned initialize payload before launching", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();
    const frames = sends.get(root!.handle.session)!.filter((f) => f.type === "request");
    expect(frames[0].command).toBe("initialize");
    const args = frames[0].arguments as Record<string, unknown>;
    expect(args.linesStartAt1).toBe(true);
    expect(args.columnsStartAt1).toBe(true);
    expect(args.adapterID).toBe("js-debug");
    expect(frames[1].command).toBe("launch");
    expect(root!.capabilities).toEqual({ supportsConfigurationDoneRequest: true });
  });
});

describe("starting", () => {
  it("collapses two concurrent starts into one run", async () => {
    const m = await freshModule();
    const [a, b] = await Promise.all([m.startDebugSession(start), m.startDebugSession(start)]);
    await flush();

    // Holding F5 must not launch a program per keypress with only the last one
    // on screen. Serialized per adapter id, and the second start joins the run
    // the first brought up.
    expect(calls.filter((c) => c.cmd === "dap_start")).toHaveLength(1);
    expect(m.debugRoots()).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("starts a separate run for a different project", async () => {
    const m = await freshModule();
    await m.startDebugSession(start);
    await m.startDebugSession({ ...start, projectPath: "/other", filePath: "/other/x.ts" });
    await flush();
    expect(m.debugRoots()).toHaveLength(2);
  });

  it("returns null and registers nothing when the adapter will not start", async () => {
    const m = await freshModule();
    startFails = true;
    expect(await m.startDebugSession(start)).toBeNull();
    expect(m.debugRoots()).toHaveLength(0);
  });

  it("stops an in-flight start by handle when the project changes underneath it", async () => {
    const m = await freshModule();
    let release!: () => void;
    holdStart = new Promise<void>((r) => (release = r));

    const pending = m.startDebugSession(start);
    // Let the start reach `dap_start` before the project changes, so this
    // exercises the branch where the adapter is genuinely already coming up
    // rather than the cheaper one that never spawns anything.
    await flush();
    expect(calls.filter((c) => c.cmd === "dap_start")).toHaveLength(1);
    await m.stopAllDap();
    release();
    expect(await pending).toBeNull();
    await flush();

    // The adapter this call brought up is a real running process, and
    // `dap_stop_all` has already swept past it. Stopped by its own id, or it
    // and its debuggee outlive the project that asked for them.
    expect(calls.filter((c) => c.cmd === "dap_stop")).toHaveLength(1);
    expect(m.debugRoots()).toHaveLength(0);
  });
});

describe("stopping", () => {
  it("tears down every run and stops every adapter", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();
    await startDebugging(root!.handle.session, { __pendingTargetId: "t1" });

    await m.stopAllDap();

    expect(m.debugSessions()).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "dap_stop_all")).toHaveLength(1);
  });

  it("stops the whole run when asked from a child", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();
    await startDebugging(root!.handle.session, { __pendingTargetId: "t1" });
    const child = root!.children[0];

    await m.stopDebugRun(child);

    // "Stop" from a child means stop this debug run: the adapter dies, and its
    // process group takes the debuggee with it.
    expect(m.debugSessions()).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "dap_stop")).toHaveLength(1);
  });

  it("is swept when the workspace changes, not when the active member moves", () => {
    // Read as source, because the alternative is mounting the whole editor to
    // observe one line of a teardown effect.
    //
    // It used to live in the same effect as the language-server retire, keyed
    // on `root`. Inside a Feature `root` is the *active member*, and moving it
    // is a pointer move: clicking another repo in the tree stopped the debuggee
    // and blanked the transcript (#160 phase 2). The run belongs to the
    // workspace, so the sweep keys on the workspace.
    const rootEffect = editorSource.slice(editorSource.indexOf("on(root, (r) => {"));
    // `touchWarmRoot`, not `retainLspRoots`: the switch reaches the LRU through
    // the cycle-free `lspWarmRoots` module now, and only asks `lspClient` to
    // stop what fell off.
    expect(rootEffect.indexOf("touchWarmRoot(")).toBeGreaterThan(
      rootEffect.indexOf("if (!r) return;"),
    );
    // And the run is no longer in that effect at all.
    expect(rootEffect.slice(0, rootEffect.indexOf("watchRoots"))).not.toContain("stopAllDap()");

    const wsEffect = editorSource.slice(editorSource.indexOf("on(wsKey, () => {"));
    const dap = wsEffect.indexOf("stopAllDap()");
    const console = wsEffect.indexOf("clearDebugConsole()");
    expect(dap).toBeGreaterThan(-1);
    // The transcript goes with it: what is on screen is another workspace's
    // program output, and the pane has no way to say whose it was.
    expect(console).toBeGreaterThan(dap);
    // Unguarded, so deselecting still sweeps. That is precisely the case where
    // nothing on screen names the run any more: swept only on the way into a
    // new workspace, a debuggee would be left holding its ports and children
    // with no way to stop it short of quitting.
    expect(wsEffect.slice(0, dap)).not.toContain("return;");
    // A memo, so a Selection rebuilt with the same key does not re-run it.
    expect(editorSource).toContain("const wsKey = createMemo(ws);");
    expect(editorSource).toContain('from "../../utils/dapSessions"');
  });

  it("rejects what a dropped session still had in flight", async () => {
    const m = await freshModule();
    const root = await m.startDebugSession(start);
    await flush();
    // A request that will never be answered, then the session goes away.
    const pending = root!.conn.request("stackTrace");
    const settled = pending.then(
      () => "resolved",
      () => "rejected",
    );
    event(root!.handle.session, "terminated");
    await flush();
    // Left pending, a paused-frame read would hang the pane forever on a
    // session that no longer exists.
    expect(await settled).toBe("rejected");
  });
});
