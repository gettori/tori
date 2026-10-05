import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

// What the adapter is told, and what it is believed about.
//
// `breakpoints.ts` owns the rules and is tested on its own. This is the wire:
// which files a session configures itself with, what a toggle sends and when it
// sends nothing at all, and where a bound marker's authority comes from. Driven
// through the real `dapSessions` against a fake adapter, so the payloads
// asserted are the ones that would go out.

type Handle = { server: string; session: string };
type Sent = { session: string; command: string; args: Record<string, unknown> };

const channels = new Map<string, { onmessage: ((m: string) => void) | null }>();
const sent: Sent[] = [];
let sessionCounter = 0;
/** What the fake adapter answers `setBreakpoints` with, per call. js-debug
 *  answers `verified: false` during the handshake and `true` once the target is
 *  live, and the difference is load-bearing. */
let verifyResponses = false;

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
        void Promise.resolve().then(() =>
          deliver(handle.session, {
            seq: 9000,
            type: "response",
            request_seq: frame.seq,
            command: frame.command,
            success: true,
            body: bodyFor(frame),
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

function bodyFor(frame: Record<string, unknown>): unknown {
  if (frame.command === "initialize") return { supportsConfigurationDoneRequest: true };
  if (frame.command !== "setBreakpoints") return {};
  const args = (frame.arguments ?? {}) as {
    source?: { path?: string };
    breakpoints?: { line: number }[];
  };
  return {
    breakpoints: (args.breakpoints ?? []).map((b) => ({
      // Measured against js-debug 1.117: every breakpoint in a file comes back
      // with the same id, which is why nothing correlates on it.
      id: 1,
      verified: verifyResponses,
      source: { path: args.source?.path },
      line: b.line,
    })),
  };
}

function deliver(session: string, frame: Record<string, unknown>): void {
  channels.get(session)?.onmessage?.(JSON.stringify(frame));
}

function event(session: string, name: string, body?: unknown): void {
  deliver(session, { seq: 1, type: "event", event: name, body });
}

/** A `breakpoint` change event, in the shape js-debug actually sends: full
 *  source and line, a duplicated id, `reason: "changed"`. */
function bound(session: string, path: string, line: number, verified = true): void {
  event(session, "breakpoint", {
    reason: "changed",
    breakpoint: { id: 1, verified, source: { name: path, path }, line, column: 3 },
  });
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function freshModules() {
  vi.resetModules();
  const sessions = await import("./dapSessions");
  // Imported second and for its side effect: it installs itself as the
  // breakpoint source on the module it watches.
  const bp = await import("./debugBreakpoints");
  return { sessions, bp };
}

const WS = "/p";
const FILE = "/p/src/index.ts";
const OTHER = "/p/src/other.ts";

const start = {
  adapterId: "js-debug",
  childSessions: true,
  filePath: FILE,
  projectPath: WS,
  config: { type: "pwa-node", request: "launch", program: FILE },
};

/** Every `setBreakpoints` payload for one file, oldest first. */
const setsFor = (path: string) =>
  sent
    .filter((s) => s.command === "setBreakpoints" && (s.args.source as { path: string }).path === path)
    .map((s) => ({
      session: s.session,
      lines: (s.args.breakpoints as { line: number }[]).map((b) => b.line),
    }));

const states = (bp: typeof import("./debugBreakpoints"), path = FILE) =>
  bp.breakpointMarks(WS, path).map((m) => `${m.line}:${m.state}`);

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  channels.clear();
  sent.length = 0;
  sessionCounter = 0;
  verifyResponses = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("what a session configures itself with", () => {
  it("sends every file that was marked before the run started", async () => {
    const { sessions, bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 6);
    bp.toggleBreakpointAt(WS, OTHER, 2);

    await sessions.startDebugSession(start);
    await flush();
    event("sess0", "initialized");
    await flush();

    // The whole point of the seam: a breakpoint set with nothing running still
    // reaches the adapter, before `configurationDone`.
    expect(setsFor(FILE)).toEqual([{ session: "sess0", lines: [6] }]);
    expect(setsFor(OTHER)).toEqual([{ session: "sess0", lines: [2] }]);
    const order = sent.filter((s) => s.session === "sess0").map((s) => s.command);
    expect(order.indexOf("configurationDone")).toBeGreaterThan(order.lastIndexOf("setBreakpoints"));
  });

  it("leaves out a file with unsaved edits", async () => {
    const { sessions, bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 6);
    bp.toggleBreakpointAt(WS, OTHER, 2);
    bp.noteBufferDirty(WS, FILE, true);

    await sessions.startDebugSession(start);
    await flush();
    event("sess0", "initialized");
    await flush();

    // Its line numbers describe a buffer the adapter cannot see, so arming them
    // would stop somewhere in the file on disk that nobody pointed at.
    expect(setsFor(FILE)).toEqual([]);
    expect(setsFor(OTHER)).toHaveLength(1);
  });
});

describe("a toggle while a run is live", () => {
  async function running() {
    const { sessions, bp } = await freshModules();
    const root = await sessions.startDebugSession(start);
    await flush();
    // A child, the way js-debug makes one: every launch is multi-session, and
    // the child is the one that actually binds.
    deliver(root!.handle.session, {
      seq: 500,
      type: "request",
      command: "startDebugging",
      arguments: { configuration: { __pendingTargetId: "t1" }, request: "launch" },
    });
    await flush();
    sent.length = 0;
    return { sessions, bp, root: root! };
  }

  it("reaches every session in the run", async () => {
    const { bp } = await running();
    bp.toggleBreakpointAt(WS, FILE, 6);
    await flush();

    // Each session is its own DAP connection with its own breakpoint set; the
    // one that binds is not the one that was launched.
    expect(setsFor(FILE)).toEqual([
      { session: "sess0", lines: [6] },
      { session: "sess1", lines: [6] },
    ]);
  });

  it("sends the whole file, and an empty set to clear it", async () => {
    const { bp } = await running();
    bp.toggleBreakpointAt(WS, FILE, 6);
    bp.toggleBreakpointAt(WS, FILE, 9);
    await flush();
    bp.toggleBreakpointAt(WS, FILE, 6);
    await flush();

    // DAP replaces a file's set on every call, so removing one means sending the
    // rest, and removing the last means sending nothing rather than not sending.
    expect(setsFor(FILE).filter((s) => s.session === "sess0")).toEqual([
      { lines: [6], session: "sess0" },
      { lines: [6, 9], session: "sess0" },
      { lines: [9], session: "sess0" },
    ]);
  });

  it("touches no other file", async () => {
    const { bp } = await running();
    bp.toggleBreakpointAt(WS, FILE, 6);
    await flush();

    expect(setsFor(OTHER)).toEqual([]);
  });
});

describe("a buffer with unsaved edits", () => {
  it("shows pending and sends nothing until the save", async () => {
    const { sessions, bp } = await freshModules();
    await sessions.startDebugSession(start);
    await flush();
    sent.length = 0;

    bp.noteBufferDirty(WS, FILE, true);
    bp.toggleBreakpointAt(WS, FILE, 6);
    await flush();

    // Arming a line number against text the adapter has never seen is how a
    // debugger stops in the wrong place with nothing to say it moved.
    expect(setsFor(FILE)).toEqual([]);
    expect(states(bp)).toEqual(["6:pending"]);
  });

  it("arms the line the edit left it on, not the one you clicked", async () => {
    const { sessions, bp } = await freshModules();
    await sessions.startDebugSession(start);
    await flush();
    sent.length = 0;

    bp.noteBufferDirty(WS, FILE, true);
    bp.toggleBreakpointAt(WS, FILE, 6);
    // Five lines inserted above it: the gutter maps its position through the
    // edit and reports back, which is the order the save pipeline runs in.
    bp.breakpointsMoved(WS, FILE, [11], 60);
    await flush();
    expect(setsFor(FILE)).toEqual([]);

    bp.noteBufferDirty(WS, FILE, false);
    await flush();

    // `formatOnSave` and `organizeOnSave` rewrite the file before the bytes are
    // written, and their edits arrive here the same way any other edit does, so
    // what is armed matches the file that is now on disk.
    expect(setsFor(FILE)).toEqual([{ session: "sess0", lines: [11] }]);
    expect(states(bp)).toEqual(["11:armed"]);
  });

  it("stops being pending when the buffer is closed", async () => {
    const { sessions, bp } = await freshModules();
    await sessions.startDebugSession(start);
    await flush();
    bp.noteBufferDirty(WS, FILE, true);
    bp.toggleBreakpointAt(WS, FILE, 6);
    sent.length = 0;

    bp.noteBufferClosed(WS, FILE);
    await flush();

    // Closing a dirty tab is a save that never comes. Left pending, this file
    // would be left out of every future run's configuration with no gutter left
    // to say why.
    expect(states(bp)).toEqual(["6:armed"]);
    expect(setsFor(FILE)).toEqual([{ session: "sess0", lines: [6] }]);
  });

  it("keeps every breakpoint in the file pending, not only the new one", async () => {
    const { bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 3);
    bp.noteBufferDirty(WS, FILE, true);
    bp.toggleBreakpointAt(WS, FILE, 8);

    // The moment the buffer differs from what the adapter was told, no line in
    // it can be claimed to be armed.
    expect(states(bp)).toEqual(["3:pending", "8:pending"]);
  });
});

describe("where a bound marker comes from", () => {
  it("is not the handshake response, which always says no", async () => {
    const { sessions, bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 6);
    await sessions.startDebugSession(start);
    await flush();
    event("sess0", "initialized");
    await flush(20);

    // Phase 1 measured `verified: false, "provisionalBreakpoint"` on every
    // handshake response, including breakpoints that then bound and stopped.
    // Reading it as an answer would render every breakpoint permanently
    // unbound.
    expect(states(bp)).toEqual(["6:armed"]);
  });

  it("is the breakpoint event", async () => {
    const { sessions, bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 6);
    await sessions.startDebugSession(start);
    await flush();
    bound("sess0", FILE, 6);

    expect(states(bp)).toEqual(["6:bound"]);
  });

  it("keys on the file and the line, never on the id", async () => {
    const { sessions, bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 6);
    bp.toggleBreakpointAt(WS, FILE, 9);
    bp.toggleBreakpointAt(WS, OTHER, 6);
    await sessions.startDebugSession(start);
    await flush();

    // Both of this file's breakpoints carry `id: 1` in js-debug's own events, so
    // an id-keyed store would flip whichever it saw first and call it a day.
    bound("sess0", FILE, 9);

    expect(states(bp)).toEqual(["6:armed", "9:bound"]);
    // And the same line in a different file is a different breakpoint.
    expect(states(bp, OTHER)).toEqual(["6:armed"]);
  });

  it("is a live response too, since that one is answered by a running target", async () => {
    const { sessions, bp } = await freshModules();
    await sessions.startDebugSession(start);
    await flush();
    verifyResponses = true;
    bp.toggleBreakpointAt(WS, FILE, 6);
    await flush();

    // Sent while the target is up, js-debug answers `verified: true` at once.
    // Taking it costs nothing and covers the case where no event follows.
    expect(states(bp)).toEqual(["6:bound"]);
  });

  it("goes back to armed when the adapter unbinds it", async () => {
    const { sessions, bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 6);
    await sessions.startDebugSession(start);
    await flush();
    bound("sess0", FILE, 6);
    expect(states(bp)).toEqual(["6:bound"]);

    bound("sess0", FILE, 6, false);
    expect(states(bp)).toEqual(["6:armed"]);
  });

  it("does not carry over to a line that was cleared and set again", async () => {
    const { sessions, bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 6);
    await sessions.startDebugSession(start);
    await flush();
    bound("sess0", FILE, 6);
    expect(states(bp)).toEqual(["6:bound"]);

    bp.toggleBreakpointAt(WS, FILE, 6);
    bp.toggleBreakpointAt(WS, FILE, 6);

    // A different breakpoint on the same line, and the adapter has said nothing
    // about it yet. Rendering it filled would claim execution stops there on the
    // strength of one that was removed.
    expect(states(bp)).toEqual(["6:armed"]);
  });

  it("forgets it when the run ends", async () => {
    const { sessions, bp } = await freshModules();
    bp.toggleBreakpointAt(WS, FILE, 6);
    await sessions.startDebugSession(start);
    await flush();
    bound("sess0", FILE, 6);
    expect(states(bp)).toEqual(["6:bound"]);

    event("sess0", "terminated");
    await flush();

    // Bound is a claim about a running adapter. Left standing it would tell the
    // next run's first frame that its breakpoints had already bound.
    expect(states(bp)).toEqual(["6:armed"]);
  });
});
