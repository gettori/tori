// Bridges @codemirror/lsp-client to the Rust-hosted language servers. The
// Transport is JSON-message based: send -> lsp_send (Rust frames it onto the
// server's stdin); incoming frames arrive de-framed over a Tauri Channel from
// lsp_start and are fanned out to subscribers.
//
// One client per *session*, and a session is (server id, root), not one per
// project: a monorepo resolves a different root per package, so `packages/a`
// and `packages/b` each get their own tsserver. The backend resolves the root
// and hands back the handle; nothing here re-derives it.

import { Channel, invoke } from "@tauri-apps/api/core";
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { emitWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";
import {
  ensureLspServersLoaded,
  languageIdFor,
  serverForPath,
  setRegistryListener,
  type LspServer,
} from "../../utils/lspServers";
import { symbolClientCapabilities } from "../../utils/symbols";
import { liveBufferText } from "./liveBuffers";
import { pathToUri, SwayWorkspace } from "./swayWorkspace";

/** Identifies one running server session. Produced by the backend; the
 *  frontend only ever holds and returns it. */
type LspHandle = { serverId: string; root: string };

type Session = { handle: LspHandle; client: LSPClient; workspace: SwayWorkspace };

const key = (h: LspHandle) => `${h.serverId}\u0000${h.root}`;

const sessions = new Map<string, Session>();

// Notified whenever the set of live clients changes: one comes up, one is torn
// down, or the registry lands and files that claimed nothing now claim a
// server. A buffer resolves its LSP extension once, when its EditorState is
// built, so without a signal here every file opened before its server was
// ready would stay LSP-less until it was closed and reopened.
let watchers: (() => void)[] = [];

/** Subscribe to client lifecycle changes. Returns an unsubscribe. */
export function onLspChange(cb: () => void): () => void {
  watchers.push(cb);
  return () => {
    watchers = watchers.filter((w) => w !== cb);
  };
}

// Iterates a copy: a watcher is allowed to unsubscribe from inside its own call.
function notify() {
  for (const w of [...watchers]) w();
}

// The registry landing changes what `lspPluginFor` would answer for an already
// open buffer, so it is a lifecycle transition like any other.
setRegistryListener(notify);

// The two places `sessions` is mutated, so no transition can skip the notify.
function addSession(session: Session) {
  sessions.set(key(session.handle), session);
  notify();
}

function dropAllSessions() {
  if (sessions.size === 0) return;
  for (const { client } of sessions.values()) {
    try {
      client.disconnect();
    } catch {
      // ignore
    }
  }
  sessions.clear();
  notify();
}

/** The live session that should answer for `path`, or null.
 *
 *  Longest root wins. In a monorepo a file can sit under both the repo root and
 *  its own package, and the package's server is the one with the right compiler
 *  config. This is also the `isUnderPath` guard that keeps a Docs-tree or
 *  `.shared/` file (a real file outside every project root) from being handed
 *  to a server that would answer from the wrong project. */
function sessionFor(path: string, server: LspServer): Session | null {
  let best: Session | null = null;
  for (const session of sessions.values()) {
    if (session.handle.serverId !== server.id) continue;
    if (!isUnderPath(path, session.handle.root)) continue;
    if (!best || session.handle.root.length > best.handle.root.length) best = session;
  }
  return best;
}

// Starts are serialized per server id. Two files of one language opened at once
// would otherwise both call `lsp_start` before either had registered a session;
// the backend reuses by handle and returns without wiring the second caller's
// Channel, so that second client would sit connected to a transport no frame
// ever reaches. Serializing lets the second call see the first's session and
// skip starting at all. Different servers still start in parallel.
const starting = new Map<string, Promise<unknown>>();

// Bumped by every teardown. A start already awaiting `lsp_start` cannot be
// cancelled, so it checks this on the way back: without it, switching projects
// while a server is coming up lets the in-flight start register a client for
// the project that was just torn down, and buffers get a plugin for a server
// that has already been killed.
let generation = 0;

/** Ensure a server is running for `path`, starting one if this is the first
 *  file of its language under that root. Resolves to the session that will
 *  answer for the path, or null when no server claims it.
 *
 *  Fire-and-forget from the caller's perspective: the plugin is picked up by
 *  the `onLspChange` fire, not by awaiting this. */
export async function ensureLspFor(path: string, projectPath: string): Promise<void> {
  // Captured before the first await, so a teardown anywhere after this point is
  // visible to the start: this call was made on behalf of a project that may
  // not be the current one by the time it gets a turn.
  const startedAt = generation;
  await ensureLspServersLoaded();
  const server = serverForPath(path);
  // No server for this language is the normal case, not a failure.
  if (!server) return;
  if (!isUnderPath(path, projectPath)) return;

  const prev = starting.get(server.id) ?? Promise.resolve();
  const next = prev.then(() => startFor(server, path, projectPath, startedAt)).catch(() => {});
  starting.set(server.id, next);
  await next;
}

async function startFor(
  server: LspServer,
  path: string,
  projectPath: string,
  startedAt: number,
): Promise<void> {
  // Torn down before this call reached the front of its server's queue. The
  // project it was opened for is gone, so starting its server now would spawn
  // one nothing will ever use.
  if (startedAt !== generation) return;

  // Deliberately no "is this path already covered?" short-circuit here. A file
  // can sit under a live session's root and still belong to a *nearer* one: in
  // a monorepo, opening a repo-root file first brings up a server at the repo
  // root, and `packages/a/src/index.ts` is under it but needs its own server
  // for its own tsconfig. Only the backend knows which root a file resolves to,
  // so it is asked every time and the answer is deduplicated below. Skipping
  // the call would reintroduce exactly the wrong-compiler-config failure that
  // keying sessions by (server, root) exists to prevent.
  let handlers: ((value: string) => void)[] = [];
  const channel = new Channel<string>();
  channel.onmessage = (msg) => {
    for (const h of handlers) h(msg);
  };

  let handle: LspHandle;
  try {
    handle = await invoke<LspHandle>("lsp_start", {
      serverId: server.id,
      filePath: path,
      projectPath,
      onMessage: channel,
    });
  } catch (e) {
    console.error("lsp_start failed", server.id, e);
    return;
  }

  // Torn down while we were starting. The server this call brought up is real
  // and running, and `lsp_stop_all` may already have swept past it, so stop it
  // by handle rather than dropping it on the floor.
  if (startedAt !== generation) {
    await invoke("lsp_stop", { handle }).catch(() => {});
    return;
  }

  // The backend resolved a root we already have a client for (the common case:
  // every later file under a root already served). It reuses the running
  // session and returns *without* wiring this call's Channel, so a second
  // client here would sit connected to a transport no frame ever reaches.
  if (sessions.has(key(handle))) return;

  const transport: Transport = {
    send: (message) => void invoke("lsp_send", { handle, message }).catch(() => {}),
    subscribe: (h) => handlers.push(h),
    unsubscribe: (h) => {
      handlers = handlers.filter((x) => x !== h);
    },
  };

  // Captured out of the factory below, which the client calls synchronously
  // inside its own constructor, so it is set before `connect` returns.
  let workspace: SwayWorkspace | undefined;

  // The server stays silent until it receives `initialize`, which connect()
  // sends, so no messages are missed between lsp_start and subscribing here.
  const client = new LSPClient({
    rootUri: pathToUri(handle.root),
    // Per-server, not the library's 3s default: rust-analyzer indexes a cold
    // cargo project for far longer than that, and the timeout covers
    // `initialize` too, so 3s would take the whole client down rather than
    // just failing one request.
    timeout: server.request_timeout_ms,
    // Without this the library's own workspace answers `displayFile` with the
    // view of a file that is already on screen and null for everything else,
    // which is every cross-file operation there is.
    workspace: (c) => (workspace = new SwayWorkspace(c, workspaceDeps(server))),
    // The library advertises no symbol support at all, and a conformant server
    // offers no provider for something the client never asked for, so without
    // this the outline is empty against a *correct* server.
    // Spread, not nested: `languageServerExtensions()` is itself a list of
    // these, and one of them (`serverDiagnostics`) carries capabilities of its
    // own that only get merged when the client sees it as a top-level entry.
    extensions: [...languageServerExtensions(), symbolClientCapabilities],
  }).connect(transport);

  addSession({ handle, client, workspace: workspace! });
}

function workspaceDeps(server: LspServer) {
  return {
    // Buffer before disk. A background tab is viewless and can hold unsaved
    // edits, so the filesystem is the wrong answer for exactly the files the
    // user is working on.
    bufferText: (path: string) => liveBufferText(path),
    diskText: (path: string) =>
      invoke<string>("fs_read_file", { path }).catch(() => null),
    languageId: (path: string) => languageIdFor(server, path),
    requestOpen: (path: string) => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path }),
  };
}

/** Tell every live workspace that a file changed outside its editor, so a
 *  headless snapshot does not go on describing a document that no longer
 *  exists. Cheap and harmless for a path no workspace has materialised. */
export function notifyLspFileChanged(path: string): void {
  // Caught rather than left to float: this runs a callback back into the editor
  // component, and an unhandled rejection is invisible - it does not fail a
  // test run, and here it would not fail the app either.
  for (const { workspace } of sessions.values()) {
    workspace.fileChanged(path).catch((e) => console.error("lsp fileChanged failed", path, e));
  }
}

/** What a running server is, to code that only wants to ask it something.
 *
 *  Narrow on purpose. A caller that held the `LSPClient` could reconfigure the
 *  session or disconnect it; what the symbol surfaces need is to know whether a
 *  provider exists and to send one request. */
export type LspTarget = {
  /** The root this session was started at, for naming and de-duplication. */
  root: string;
  /** Resolves once `initialize` has been answered, so `supports` is asking
   *  about capabilities that exist. Settles either way: a server that failed to
   *  initialize is not one to keep a caller waiting on. */
  ready: Promise<void>;
  /** Whether the server advertised this provider. False before `ready`, which
   *  is the honest answer: nothing has been advertised yet, and asking anyway
   *  is what draws a `MethodNotFound`. */
  supports: (capability: keyof ServerCapabilities) => boolean;
  /** Flush pending document changes. The library's own sync is debounced by
   *  500 ms, so a question about positions asked sooner than that would be
   *  answered against a document the server has not seen yet. */
  sync: () => void;
  request: <R>(method: string, params: unknown) => Promise<R>;
};

type ServerCapabilities = NonNullable<LSPClient["serverCapabilities"]>;

function targetOf(session: Session): LspTarget {
  return {
    root: session.handle.root,
    ready: session.client.initializing.then(
      () => {},
      () => {},
    ),
    supports: (capability) => !!session.client.serverCapabilities?.[capability],
    sync: () => session.client.sync(),
    request: (method, params) => session.client.request(method, params),
  };
}

/** The server answering for `path`, or null when nothing does. Same
 *  longest-root rule as the plugin, so a question about a file reaches the
 *  server holding that file's compiler config. */
export function lspTargetFor(path: string): LspTarget | null {
  const server = serverForPath(path);
  if (!server) return null;
  const session = sessionFor(path, server);
  return session ? targetOf(session) : null;
}

/** Every live server. What a workspace-wide question asks: `workspace/symbol`
 *  is scoped to one server's own root, so a monorepo with a package-level
 *  session and a repo-root session has to ask both to see the whole tree. */
export function lspTargets(): LspTarget[] {
  return [...sessions.values()].map(targetOf);
}

/** Tear down every client and stop every server. What a project switch calls:
 *  the old project's servers are all wrong at once. */
export async function stopAllLsp(): Promise<void> {
  generation += 1;
  dropAllSessions();
  starting.clear();
  await invoke("lsp_stop_all").catch(() => {});
}

/** Per-buffer editor extension for a file whose server is up, empty for
 *  anything else: an unclaimed extension, a file outside every live root, or a
 *  server that has not come up yet. Empty-while-starting is why callers hold
 *  this in a compartment and reconfigure on `onLspChange` rather than baking
 *  the result into the buffer's state. */
export function lspPluginFor(path: string): Extension {
  const server = serverForPath(path);
  if (!server) return [];
  const session = sessionFor(path, server);
  if (!session) return [];
  const languageId = languageIdFor(server, path);
  if (!languageId) return [];
  return session.client.plugin(pathToUri(path), languageId);
}
