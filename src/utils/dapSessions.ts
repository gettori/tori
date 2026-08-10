// The live debug sessions, as a tree.
//
// A debug run is never one session. Phase 1 measured `node fixture.js`, the
// smallest possible target, producing a root plus one child, and `pnpm vitest`
// producing four sessions across three levels (pnpm to node to vitest to
// worker). Depth is the normal case, not the exotic one, so this is a tree of
// arbitrary depth rather than a parent with a list of children: a flat model
// would lose a vitest worker's own workers, and a stop that only reached one
// level would leave them running with nothing on screen naming them.
//
// The mechanism is js-debug's `startDebugging` reverse request. The child is
// not a second adapter: it is a second *connection to the same adapter
// process*, carrying the `__pendingTargetId` js-debug put in the configuration
// it handed us. `dap_connect` opens exactly that, which is why the backend
// splits `dap_start` (spawn plus first session) from `dap_connect` at all.
//
// Nothing here imports CodeMirror or Solid. The pane that renders this arrives
// in Phase 4 and subscribes through `onDebugChange`.

import { Channel, invoke } from "@tauri-apps/api/core";

import {
  createDapConnection,
  initializeArguments,
  type DapConnection,
  type DapHandle,
} from "./dapClient";

export type DapSession = {
  handle: DapHandle;
  conn: DapConnection;
  /** Which adapter is behind this run, for the initialize payload and the
   *  per-adapter start queue. */
  adapterId: string;
  /** The project this run belongs to. A run outlives the file that started it
   *  but never the project, which is what `stopAllDap` enforces. */
  projectPath: string;
  /** Session id of the parent, or null for a root. */
  parent: string | null;
  /** Session ids, in the order js-debug asked for them. */
  children: string[];
  /** A stable label for the pane: `run1`, `run1.child0`, `run1.child0.child0`. */
  name: string;
  /** What the adapter answered `initialize` with, or null until it has. */
  capabilities: Record<string, unknown> | null;
  /** Whether the configuration sequence has already run. See `configureOnce`. */
  configured: boolean;
};

/** What a launch or attach is described by: the DAP configuration object,
 *  passed to the adapter verbatim. Phase 5 builds these. */
export type DebugConfig = Record<string, unknown>;

export type DebugStart = {
  adapterId: string;
  /** The file the run is about. The backend resolves the adapter's root from
   *  it, which becomes the debuggee's `cwd`, so it decides module resolution
   *  and where source maps resolve from. */
  filePath: string;
  projectPath: string;
  config: DebugConfig;
  /** Called when the adapter refuses the launch or attach.
   *
   *  A callback rather than a rejection, because `handshake` cannot await the
   *  launch response: js-debug does not answer it until `configurationDone` has
   *  been sent, and that is sent from the `initialized` handler, so awaiting
   *  would deadlock the handshake against itself. Without this the one failure
   *  a user actually hits, attaching to a port nothing is listening on, would
   *  reach a `console.warn` and nowhere else. */
  onLaunchFailed?: (error: unknown) => void;
};

const sessions = new Map<string, DapSession>();
let rootIds: string[] = [];

let watchers: (() => void)[] = [];

/** Subscribe to session-tree changes: a run starting, a child appearing, a
 *  subtree going away. Returns an unsubscribe. */
export function onDebugChange(cb: () => void): () => void {
  watchers.push(cb);
  return () => {
    watchers = watchers.filter((w) => w !== cb);
  };
}

// Iterates a copy: a watcher may unsubscribe from inside its own call.
function notify(): void {
  for (const w of [...watchers]) w();
}

/** Every root session, oldest first. */
export function debugRoots(): DapSession[] {
  return rootIds.map((id) => sessions.get(id)!).filter(Boolean);
}

/** One session by id, or null. */
export function debugSession(id: string): DapSession | null {
  return sessions.get(id) ?? null;
}

/** Every session in the tree, in no particular order. */
export function debugSessions(): DapSession[] {
  return [...sessions.values()];
}

/**
 * Where breakpoints come from when a session configures itself.
 *
 * A seam rather than an import: the store lands in Phase 6, and the protocol
 * layer having a hard dependency on the gutter would put the editor back into
 * the eager side this file exists to keep out. Maps absolute file path to
 * 1-based lines.
 */
export type BreakpointSource = (projectPath: string) => Map<string, number[]>;

let breakpointSource: BreakpointSource = () => new Map();

/** Install the breakpoint store. Called once, by the module that owns it. */
export function setDebugBreakpointSource(source: BreakpointSource): void {
  breakpointSource = source;
}

// Starts are serialized per adapter id, and a start that finds a live run for
// its adapter and project joins it rather than launching a second debuggee.
// Without this, holding F5 launches a program per keypress and only the last
// one is on screen.
const starting = new Map<string, Promise<unknown>>();

// Bumped by every teardown. A start already awaiting `dap_start` cannot be
// cancelled, so it checks this on the way back: otherwise switching projects
// while an adapter is coming up leaves a debuggee running for a project that is
// no longer open, holding its ports and its files, with nothing on screen that
// could stop it.
let generation = 0;

let runCounter = 0;

/**
 * Start a debug run, or join the one already live for this adapter and project.
 *
 * Resolves to the root session, or null when the run was refused, failed to
 * start, or was abandoned because the project changed underneath it.
 */
export async function startDebugSession(start: DebugStart): Promise<DapSession | null> {
  // Captured before the first await: by the time this call gets a turn, the
  // project it was made for may not be the current one.
  const startedAt = generation;
  const prev = starting.get(start.adapterId) ?? Promise.resolve();
  const next = prev.then(() => startRun(start, startedAt)).catch(() => null);
  starting.set(start.adapterId, next);
  return next;
}

async function startRun(start: DebugStart, startedAt: number): Promise<DapSession | null> {
  // Torn down before this call reached the front of its adapter's queue.
  if (startedAt !== generation) return null;

  const live = debugRoots().find(
    (s) => s.adapterId === start.adapterId && s.projectPath === start.projectPath,
  );
  if (live) return live;

  const wire = openConnection();
  let handle: DapHandle;
  try {
    handle = await invoke<DapHandle>("dap_start", {
      adapterId: start.adapterId,
      filePath: start.filePath,
      projectPath: start.projectPath,
      onMessage: wire.channel,
    });
  } catch (e) {
    console.error("dap_start failed", start.adapterId, e);
    return null;
  }

  // Torn down while the adapter was coming up. It is a real running process and
  // `dap_stop_all` has already swept past it, so stop it by its own id rather
  // than leaving it and whatever it launched behind.
  if (startedAt !== generation) {
    await invoke("dap_stop", { server: handle.server }).catch(() => {});
    return null;
  }

  const session = register({
    handle,
    conn: wire.attach(handle),
    adapterId: start.adapterId,
    projectPath: start.projectPath,
    parent: null,
    name: `run${runCounter++}`,
  });

  await handshake(session, start.config, start.onLaunchFailed);
  return session;
}

/**
 * Answer `startDebugging` by opening a second connection to the same adapter.
 *
 * The configuration is relayed **verbatim**. It carries js-debug's own
 * `__pendingTargetId`, which is the only thing pairing this connection with the
 * target the adapter is holding; a config rebuilt from known fields would drop
 * it and the child would attach to nothing.
 */
async function connectChild(parent: DapSession, config: DebugConfig): Promise<void> {
  const startedAt = generation;
  const wire = openConnection();
  let handle: DapHandle;
  try {
    handle = await invoke<DapHandle>("dap_connect", {
      server: parent.handle.server,
      onMessage: wire.channel,
    });
  } catch (e) {
    console.error("dap_connect failed", parent.name, e);
    return;
  }

  // The project changed, or the parent's subtree went away, while the second
  // connection was being made. Either way the adapter process is already being
  // stopped as a whole, so there is nothing here to tear down individually.
  if (startedAt !== generation || !sessions.has(parent.handle.session)) return;

  const session = register({
    handle,
    conn: wire.attach(handle),
    adapterId: parent.adapterId,
    projectPath: parent.projectPath,
    parent: parent.handle.session,
    name: `${parent.name}.child${parent.children.length}`,
  });

  await handshake(session, config);
}

function register(
  fields: Omit<DapSession, "children" | "capabilities" | "configured">,
): DapSession {
  const session: DapSession = { ...fields, children: [], capabilities: null, configured: false };
  sessions.set(session.handle.session, session);
  if (session.parent === null) rootIds = [...rootIds, session.handle.session];
  else sessions.get(session.parent)?.children.push(session.handle.session);
  wireSession(session);
  notify();
  return session;
}

function wireSession(session: DapSession): void {
  const { conn } = session;

  conn.onReverse("startDebugging", (args) => {
    const request = (args ?? {}) as { configuration?: DebugConfig; request?: string };
    const config = request.configuration ?? {};
    // Answered synchronously, and the child is dialled afterwards. js-debug is
    // blocked on this response, and the child's handshake runs over its own
    // connection, so nothing about it depends on the answer being deferred.
    void connectChild(session, { ...config, request: config.request ?? request.request ?? "launch" });
    return {};
  });

  conn.on("initialized", () => configureOnce(session));

  // The entry pause, continued straight through.
  //
  // Launch configs carry `stopOnEntry: true`, and not because anyone wants to
  // look at a program's first line. Phase 1 proved the TypeScript breakpoint
  // failure is a *race*: a short-lived target runs to completion before
  // js-debug has resolved its source map, so the breakpoint never binds, and
  // four variants of `outFiles` / `resolveSourceMapLocations` changed nothing.
  // Pausing at entry is what creates the window the map resolves in. It is
  // Sway's own pause, so nothing must surface it: `debugStore` ignores this
  // reason too, and the pane never shows a stop nobody asked for.
  conn.on("stopped", (body) => {
    const stop = (body ?? {}) as { reason?: string; threadId?: number };
    if (stop.reason !== "entry") return;
    void conn
      .request("continue", { threadId: stop.threadId })
      .catch((e: unknown) => console.warn("continue after entry stop failed", session.name, e));
  });

  // The session is over. Its own children are gone with it; a root additionally
  // takes the adapter process down, since nothing else will.
  conn.on("terminated", () => void endSession(session.handle.session));
}

/**
 * Run the configuration sequence, exactly once per session.
 *
 * **js-debug emits `initialized` more than once per session.** Running the
 * sequence again re-sends `setBreakpoints`, which *replaces* that file's set,
 * and at that moment the adapter answers `[]`: the provisional breakpoint the
 * first pass registered is silently wiped. The symptom is a breakpoint that
 * simply never fires, with nothing logged anywhere. This guard is the fix, and
 * it cost most of a Phase 1 afternoon to find.
 */
function configureOnce(session: DapSession): void {
  if (session.configured) return;
  session.configured = true;
  void configure(session);
}

async function configure(session: DapSession): Promise<void> {
  for (const [file, lines] of breakpointSource(session.projectPath)) {
    try {
      await session.conn.request("setBreakpoints", {
        source: { path: file },
        breakpoints: lines.map((line) => ({ line })),
      });
    } catch (e) {
      console.warn("setBreakpoints failed", file, e);
    }
  }
  try {
    await session.conn.request("configurationDone");
  } catch (e) {
    console.warn("configurationDone failed", session.name, e);
  }
}

async function handshake(
  session: DapSession,
  config: DebugConfig,
  onLaunchFailed?: (error: unknown) => void,
): Promise<void> {
  try {
    session.capabilities = (await session.conn.request<Record<string, unknown>>(
      "initialize",
      initializeArguments(session.adapterId),
    )) ?? {};
  } catch (e) {
    console.error("initialize failed", session.name, e);
    await endSession(session.handle.session);
    return;
  }
  notify();

  // Deliberately not awaited. js-debug does not answer `launch` until
  // `configurationDone` has been sent, and that is sent from the `initialized`
  // handler above, so awaiting here would deadlock the handshake against
  // itself.
  const verb = config.request === "attach" ? "attach" : "launch";
  void session.conn.request(verb, config).catch((e: unknown) => {
    // A session that is no longer in the tree was torn down, not refused: this
    // rejection is `dispose` rejecting what was in flight when somebody pressed
    // stop. Reporting it would answer a deliberate stop with "could not start
    // the debugger", and on a large run there is one of these per session (a
    // measured `pnpm test` had 214).
    if (!sessions.has(session.handle.session)) return;
    console.warn(`${verb} failed`, session.name, e);
    onLaunchFailed?.(e);
  });
}

/** Drop `id` and everything below it, and stop the adapter if it was a root. */
async function endSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const isRoot = session.parent === null;
  const server = session.handle.server;
  dropSubtree(id);
  notify();
  if (isRoot) await invoke("dap_stop", { server }).catch(() => {});
}

/**
 * Stop one debug run: the session named, its whole subtree, and the adapter
 * process behind it.
 *
 * Takes any session in the run, not just its root: a stop asked for from a
 * child means "stop this debug run", and killing the adapter is what actually
 * ends a launched debuggee, since the backend kills its whole process group.
 */
export async function stopDebugRun(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  const server = session.handle.server;
  for (const root of debugRoots().filter((r) => r.handle.server === server)) {
    dropSubtree(root.handle.session);
  }
  notify();
  await invoke("dap_stop", { server }).catch(() => {});
}

/** Remove a session and every descendant, disposing each connection. Callers
 *  notify once, after the whole subtree is gone, so no watcher ever observes a
 *  half-collapsed tree. */
function dropSubtree(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  for (const child of [...session.children]) dropSubtree(child);
  session.conn.dispose(`debug session ${session.name} ended`);
  sessions.delete(id);
  if (session.parent === null) rootIds = rootIds.filter((r) => r !== id);
  else {
    const parent = sessions.get(session.parent);
    if (parent) parent.children = parent.children.filter((c) => c !== id);
  }
}

/**
 * Tear down every debug run and stop every adapter.
 *
 * What a project switch calls, for the reason `stopAllLsp` exists and one more
 * besides: the previous project's runs are all wrong at once, and a debuggee
 * left behind holds ports, file handles and its own child processes with
 * nothing on screen that names it.
 */
export async function stopAllDap(): Promise<void> {
  generation += 1;
  for (const id of [...rootIds]) dropSubtree(id);
  sessions.clear();
  rootIds = [];
  starting.clear();
  notify();
  await invoke("dap_stop_all").catch(() => {});
}

/**
 * A Channel wired to a connection that does not exist yet.
 *
 * `dap_start` resolves with the handle the connection needs in order to send,
 * so the connection cannot be built before the invoke returns, and frames can
 * in principle arrive before it does. Buffering rather than reasoning about
 * whether an adapter can speak first: the ordering argument is true today and
 * is not worth re-deriving every time the handshake changes.
 */
function openConnection(): {
  channel: Channel<string>;
  attach: (handle: DapHandle) => DapConnection;
} {
  const channel = new Channel<string>();
  let conn: DapConnection | null = null;
  const buffered: string[] = [];
  channel.onmessage = (message) => {
    if (conn) conn.receive(message);
    else buffered.push(message);
  };
  return {
    channel,
    attach(handle) {
      conn = createDapConnection(
        (message) => void invoke("dap_send", { handle, message }).catch(() => {}),
      );
      for (const message of buffered.splice(0)) conn.receive(message);
      return conn;
    },
  };
}
