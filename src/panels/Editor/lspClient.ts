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
import { listen } from "@tauri-apps/api/event";
import {
  findReferencesKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  LSPClient,
  signatureHelp,
  type Transport,
} from "@codemirror/lsp-client";
import { ChangeSet, type Extension, type Text } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "../../utils/events";
import { isUnderPath } from "../../utils/pathScope";
import { sanitizeHtml } from "../../utils/sanitizeHtml";
import { askToTrust, noteRefused, onTrustChange, UNTRUSTED } from "../../utils/projectTrust";
import { NOT_INSTALLED, offerInstall, onServerInstalled } from "../../utils/serverInstall";
import { dropDiagnostics, dropDiagnosticsUnder } from "../../utils/diagnostics";
import {
  ensureLspServersLoaded,
  forgetResolutions,
  hasServerFor,
  isActivationMarker,
  languageIdFor,
  onLspDisabledChange,
  onLspRestartRequest,
  primariesClaiming,
  resolvedPrimary,
  resolvedServerIds,
  resolveServers,
  serverById,
  setRegistryListener,
  type LspFeature,
  type LspServer,
  type Resolution,
} from "../../utils/lspServers";
import {
  clearProgress,
  progressClientCapabilities,
  progressScopeChanged,
  setProgressScope,
  trackProgress,
} from "../../utils/lspProgress";
import { askServerQuestion, dropServerQuestions } from "../../utils/lspMessages";
import { lspLogTabId } from "../../utils/syntheticTabs";
import { TORI_SETTINGS_FILES } from "../../utils/toriSettingsFiles";
import { callHierarchyClientCapabilities } from "../../utils/callHierarchy";
import { symbolClientCapabilities } from "../../utils/symbols";
import { semanticTokensClientCapabilities } from "../../utils/semanticTokens";
import { writeFilesSuppressingEcho } from "./batchWrite";
import { toDoc } from "./docDiff";
import { adoptBufferText, dirtyBuffers, keptFromServers, liveBufferText } from "./liveBuffers";
import { codeActionClientCapabilities } from "./lspCodeActions";
import { codeLensClientCapabilities } from "./lspCodeLens";
import { completionClientCapabilities, toriCompletion } from "./lspCompletion";
import { configurationClientCapabilities, configurationFor } from "./lspConfiguration";
import {
  clearDiagnosticContext,
  diagnosticContextCapture,
  dropDiagnosticContextUnder,
  rememberDiagnostics,
} from "./lspDiagnosticContext";
import { changesToNow, offsetIn, publishFrom, serverDiagnosticsFor, toEditorDiagnostics } from "./lspDiagnostics";
import { SecondaryClient, feedFor, secondaryFeed, type FeedTarget, type Publish } from "./secondaryClient";
import { answerApplyEdit, workspaceEditClientCapabilities } from "./serverEdits";
import { createRequestRouter } from "./serverRequests";
import { pathToUri, ToriWorkspace, uriToPath } from "./toriWorkspace";
import { clearWarmRoots, touchWarmRoot, underWarmRoot } from "./lspWarmRoots";
import type { ApplyDeps, MaterialisedFile, Mapping } from "./workspaceEdit";

/** Identifies one running server session. Produced by the backend; the
 *  frontend only ever holds and returns it. */
type LspHandle = { serverId: string; root: string };

/** The file a session was first started for. A restart asks the backend for a
 *  root again, and this file is the one known to resolve to this session's,
 *  whether or not its tab is still open. */
type Origin = { path: string; projectPath: string };

type PrimarySession = {
  kind: "primary";
  handle: LspHandle;
  client: LSPClient;
  workspace: ToriWorkspace;
  /** The config this session was started from. Held so the requests Tori
   *  answers can read the server's own `[settings]`: a `workspace/configuration`
   *  arrives with nothing but section names, and the answer is this server's,
   *  not whatever the last-started one happened to want. */
  server: LspServer;
  origin: Origin;
};

type SecondarySession = {
  kind: "secondary";
  handle: LspHandle;
  client: SecondaryClient;
  server: LspServer;
  origin: Origin;
};

type Session = PrimarySession | SecondarySession;

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
  progressScopeChanged();
  for (const w of [...watchers]) w();
}

// The registry landing changes what `lspPluginFor` would answer for an already
// open buffer, so it is a lifecycle transition like any other.
setRegistryListener(notify);

setProgressScope((path) => answeringSession(path)?.handle ?? null);

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
  clearProgress();
  dropServerQuestions();
  // Every diagnostic held there was published by a server that is now gone, and
  // the next project's files can spell their URIs the same way.
  clearDiagnosticContext();
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

// A buffer asks for its server once, on open, so a trust change has to ask
// again on behalf of every file still open under the project it touched.
const requested = new Map<string, string>();

onTrustChange(({ path, trusted }) => {
  const underScope = (_file: string, projectPath: string) => isUnderPath(projectPath, path);
  if (trusted) reask(underScope);
  else void stopLspUnder(path).then(() => reask(underScope));
});

onServerInstalled((serverId) => reask((file) => resolvedServerIds(file)?.includes(serverId) ?? false));

// A session that is live restarts from its own origin, since the file on screen
// may resolve to a nearer root than the one it is being served from. One that
// is gone, a crash the toast was dismissed on, starts from the file on screen.
onLspRestartRequest((path, serverId) => {
  const server = serverById(serverId);
  const projectPath = requested.get(path);
  if (!server || !projectPath) return;
  const live = sessionFor(path, server) ?? undefined;
  void restart(server, live?.origin ?? { path, projectPath }, live);
});

function pruneClosed(): void {
  for (const file of requested.keys()) if (liveBufferText(file) === null) requested.delete(file);
}

function reask(wanted: (file: string, projectPath: string) => boolean): void {
  pruneClosed();
  for (const [file, projectPath] of requested) {
    if (wanted(file, projectPath)) void ensureLspFor(file, projectPath);
  }
}

/** `lsp.disabled` changed, in the user's settings or a workspace's: every open
 *  file may now get different servers. */
export function lspSettingsChanged(): void {
  void reresolve(
    () => true,
    () => forgetResolutions(),
  );
}

onLspDisabledChange(lspSettingsChanged);

// A server that just lost an open file is stopped once no open file under its
// root still resolves to it, so a disabled one does not idle until a restart.
// Only a loser is judged: a server nobody has a file open for stays warm.
async function reresolve(inScope: (file: string) => boolean, forget: () => void): Promise<void> {
  pruneClosed();
  const files = [...requested].filter(([file]) => inScope(file));
  const before = new Map(files.map(([file]) => [file, resolvedServerIds(file) ?? []]));
  forget();
  const lost: [file: string, serverId: string][] = [];
  await Promise.all(
    files.map(async ([file, projectPath]) => {
      const was = before.get(file) ?? [];
      const now = await resolveServers(file, projectPath).then(
        ({ resolution }) => [resolution.primary, ...resolution.secondaries],
        () => was,
      );
      for (const id of was) if (!now.includes(id)) lost.push([file, id]);
    }),
  );
  for (const session of [...sessions.values()]) {
    const flipped = lost.filter(([file, id]) => id === session.server.id && isUnderPath(file, session.handle.root));
    if (!flipped.length) continue;
    const stillWanted = [...requested.keys()].some(
      (file) => isUnderPath(file, session.handle.root) && resolvedServerIds(file)?.includes(session.server.id),
    );
    if (!stillWanted) void stopSession(session);
    for (const [file] of flipped) {
      if (session.kind === "primary" && !stillWanted) {
        dropDiagnostics(file);
        rememberDiagnostics(pathToUri(file), session.server.id, []);
      } else if (session.kind === "secondary" && stillWanted) {
        session.client.close(file);
        retract(session.server.id, file);
      }
    }
  }
  notify();
  for (const [file, projectPath] of files) void ensureLspFor(file, projectPath);
}

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
  // No server for this language is the normal case, not a failure.
  if (!hasServerFor(path)) return;
  if (!isUnderPath(path, projectPath)) return;
  pruneClosed();
  requested.set(path, projectPath);
  for (const r of touchWarmRoot(projectPath)) void stopLspUnder(r);

  let resolution: Resolution;
  try {
    const answer = await resolveServers(path, projectPath);
    resolution = answer.resolution;
    // A buffer built before the answer landed chose its plugin without it.
    if (answer.fresh) notify();
  } catch (e) {
    console.error("lsp_resolve failed", path, e);
    return;
  }
  const wanted = [resolution.primary, ...resolution.secondaries].map((id) => (id ? serverById(id) : null));
  await Promise.all(wanted.map((server) => server && queueStart(server, path, projectPath, startedAt)));
}

function queueStart(server: LspServer, path: string, projectPath: string, startedAt: number): Promise<void> {
  const prev = starting.get(server.id) ?? Promise.resolve();
  const next = prev.then(() => startFor(server, path, projectPath, startedAt)).catch(() => {});
  starting.set(server.id, next);
  return next;
}

/** Stop `live` if it is still running, then start its server again from
 *  `origin`. Awaits the stop, because the backend hands a start the running
 *  session for its handle rather than a new one. */
async function restart(server: LspServer, origin: Origin, live?: Session): Promise<void> {
  const startedAt = generation;
  wrongEncoding.delete(server.id);
  if (live) {
    await stopSession(live);
    notify();
  }
  await queueStart(server, origin.path, origin.projectPath, startedAt);
}

async function startFor(server: LspServer, path: string, projectPath: string, startedAt: number): Promise<void> {
  // Torn down before this call reached the front of its server's queue. The
  // project it was opened for is gone, so starting its server now would spawn
  // one nothing will ever use.
  if (startedAt !== generation) return;
  if (wrongEncoding.has(server.id)) return;

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
    // `handle` is assigned when `lsp_start` resolves, which is before the
    // client below is built - and a server sends nothing at all until it has
    // been sent `initialize`, which only that client does. So by the time
    // anything worth intercepting arrives, this is not reading an unset binding.
    if (server.role !== "secondary" && (interceptServerRequest(handle, msg) || interceptProgress(handle, msg))) return;
    for (const h of handlers) h(msg);
  };

  await watchExits();
  const ours = key({ serverId: server.id, root: "" });
  for (const k of diedEarly) if (k.startsWith(ours)) diedEarly.delete(k);
  let handle: LspHandle;
  try {
    handle = await invoke<LspHandle>("lsp_start", {
      serverId: server.id,
      filePath: path,
      projectPath,
      onMessage: channel,
    });
  } catch (e) {
    if (e === UNTRUSTED) {
      if (noteRefused(projectPath)) {
        askToTrust(projectPath, "Language servers that run this project's code stay off until you trust it.");
      }
      return;
    }
    if (e === NOT_INSTALLED) {
      offerInstall(server.id, server.label, path);
      return;
    }
    console.error("lsp_start failed", server.id, e);
    return;
  }
  const died = diedEarly.delete(key(handle));

  // Torn down while we were starting. The server this call brought up is real
  // and running, and `lsp_stop_all` may already have swept past it, so stop it
  // by handle rather than dropping it on the floor.
  if (startedAt !== generation) {
    await invoke("lsp_stop", { handle }).catch(() => {});
    return;
  }

  // The switch outran the start: this call was queued for a project that has
  // since been evicted from the warm set, and its server is real and running,
  // so stop it by handle rather than registering a session nothing will claim.
  if (!underWarmRoot(handle.root)) {
    await invoke("lsp_stop", { handle }).catch(() => {});
    return;
  }

  // The backend resolved a root we already have a client for (the common case:
  // every later file under a root already served). It reuses the running
  // session and returns *without* wiring this call's Channel, so a second
  // client here would sit connected to a transport no frame ever reaches.
  if (sessions.has(key(handle))) return;

  if (died) {
    toastCrash(server, handle, { path, projectPath });
    return;
  }

  const send = (message: string) => void invoke("lsp_send", { handle, message }).catch(() => {});
  if (server.role === "secondary") {
    const client: SecondaryClient = new SecondaryClient({
      send,
      rootUri: pathToUri(handle.root),
      timeoutMs: server.request_timeout_ms,
      settings: server.settings,
      initializationOptions: server.initialization_options,
      onDiagnostics: (publish) => showSecondaryDiagnostics(server.id, client, publish),
      applyEdit: (params) =>
        answerApplyEdit(params, secondaryApplyDeps(client, "lsp.applyEdit"), (message) =>
          emitWith<ToastEvent>(TOAST, { message, kind: "error" }),
        ),
    });
    handlers.push((msg) => client.receive(msg));
    addSession({ kind: "secondary", handle, client, server, origin: { path, projectPath } });
    return;
  }

  const transport: Transport = {
    send,
    subscribe: (h) => handlers.push(h),
    unsubscribe: (h) => {
      handlers = handlers.filter((x) => x !== h);
    },
  };

  // Captured out of the factory below, which the client calls synchronously
  // inside its own constructor, so it is set before `connect` returns.
  let workspace: ToriWorkspace | undefined;

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
    workspace: (c) => (workspace = new ToriWorkspace(c, workspaceDeps(server))),
    // The library puts a server's documentation into innerHTML as rendered,
    // and a doc comment is whatever a dependency's author wrote.
    sanitizeHTML: sanitizeHtml,
    extensions: clientExtensions(server.id),
  }).connect(transport);

  addSession({ kind: "primary", handle, client, workspace: workspace!, server, origin: { path, projectPath } });
  void configureSession(handle, client, server);
}

// Refused once per server id for the life of the app: the encoding belongs to
// the binary, and every file opened after would start it and refuse it again.
const wrongEncoding = new Set<string>();

// The library turns positions into offsets by indexing JS strings, which is
// UTF-16, with no hook to do otherwise. A server counting any other way would
// put every edit and diagnostic in the wrong column on a non-ASCII line.
function refuseEncoding(handle: LspHandle, server: LspServer, encoding: string): void {
  wrongEncoding.add(server.id);
  const session = sessions.get(key(handle));
  if (session?.kind === "primary") retractPrimary(session);
  if (session) dropSession(session);
  notify();
  const shutdown = JSON.stringify({ jsonrpc: "2.0", id: "tori-shutdown", method: "shutdown", params: null });
  void invoke("lsp_send", { handle, message: shutdown }).catch(() => {});
  notifyServer(handle, "exit", null);
  void invoke("lsp_stop", { handle }).catch(() => {});
  emitWith<ToastEvent>(TOAST, {
    message: `${server.label} was stopped: it counts positions in ${encoding}, and Tori only reads UTF-16.`,
  });
}

/** Fire-and-forget one JSON-RPC notification at a session's server. */
function notifyServer(handle: LspHandle, method: string, params: unknown): void {
  const message = JSON.stringify({ jsonrpc: "2.0", method, params });
  void invoke("lsp_send", { handle, message }).catch(() => {});
}

/**
 * Associations for Tori's own settings files, or none if this build has no
 * schema directory.
 *
 * The `file:` URI is the point of the exercise: these schemas are on disk
 * beside the app rather than on SchemaStore, and the server reads a `file:`
 * schema itself (`jsonServerMain.js:32-45`). That is safe here for the reason
 * `associations_from_catalog` refuses one: this path is Tori's own resource
 * directory, not a URL out of a document written by somebody else.
 */
async function toriSettingsAssociations(): Promise<{ uri: string; fileMatch: string[] }[]> {
  const dir = await invoke<string | null>("lsp_schema_dir").catch(() => null);
  if (!dir) return [];
  return TORI_SETTINGS_FILES.map((file) => ({
    uri: pathToUri(`${dir}/${file.schema}`),
    fileMatch: [file.fileMatch],
  }));
}

/**
 * Everything a session is told once it has finished handshaking.
 *
 * After `initializing` rather than before, because a server is entitled to
 * ignore anything sent before it has answered `initialize`. Re-checked against
 * the live session afterwards: a project switch during the handshake leaves
 * this holding a handle whose server has already been stopped.
 *
 * Both steps are optional and both fail soft. A server with no `[settings]` is
 * told nothing, and a JSON server whose catalog could not be fetched is sent no
 * associations rather than an empty list that would clear the ones it has.
 */
async function configureSession(handle: LspHandle, client: LSPClient, server: LspServer): Promise<void> {
  let initialized = true;
  await client.initializing.catch(() => {
    initialized = false;
  });
  if (!initialized || sessions.get(key(handle))?.client !== client) return;

  const encoding = client.serverCapabilities?.positionEncoding;
  if (encoding && encoding !== "utf-16") return refuseEncoding(handle, server, encoding);

  if (server.settings) notifyServer(handle, "workspace/didChangeConfiguration", { settings: server.settings });

  if (server.schema_associations) {
    // Empty covers every uninteresting case identically - offline, a catalog
    // that would not parse, a cache that was never written - because the answer
    // to all of them is the same: no associations, so JSON files edit without
    // validation, exactly as they did before this server existed. The backend
    // logs the reason once per process rather than once per session.
    const catalog = await invoke<unknown[]>("lsp_schema_associations").catch(() => []);
    // Tori's own schemas first, and gathered separately from the catalog's: they
    // are files this build ships, so they are there whether or not the network
    // was, and folding them in here is what keeps the settings files described
    // on the offline path that returns nothing above.
    const associations = [...(await toriSettingsAssociations()), ...catalog];
    if (!associations.length || sessions.get(key(handle))?.client !== client) return;
    // Wrapped in an array, and that is the whole notification working or not.
    // This server is built on `vscode-jsonrpc`, which reads a JSON-RPC `params`
    // *array* as a positional argument list and spreads it across the handler.
    // Sending the associations bare therefore delivers only the first one, with
    // no error anywhere: the server simply knows about one schema. `[list]` is
    // one positional argument that happens to be a list, which is what it wants.
    notifyServer(handle, "json/schemaAssociations", [associations]);
  }
}

/**
 * Everything every client is built with: the editor extensions it hands each
 * buffer, and the capability blocks it merges into `initialize`.
 *
 * The library advertises no symbol support at all, and a conformant server
 * offers no provider for something the client never asked for, so without the
 * blocks below the outline is empty against a *correct* server.
 *
 * Written out rather than spread from `languageServerExtensions()`, which is
 * these same four library entries plus `serverCompletion()` where
 * `toriCompletion()` is here. Auto-import needs `completionItem/resolve` sent
 * between the pick and the commit, and the library builds each option's `apply`
 * while mapping the reply, with `apply` synchronous - so there is nothing to
 * wrap or configure, only to replace (see `lspCompletion.ts`). The rest are
 * carried over unchanged apart from the keymap (see below), and each stays a
 * **top-level** entry because that is the only place the client merges an
 * extension's own `clientCapabilities`, which `serverDiagnosticsFor()` has.
 *
 * Exported so a test can build the same client the app does, rather than a
 * hand-assembled one that could drift from it.
 */
export function clientExtensions(serverId: string) {
  return [
    // Ahead of `serverDiagnosticsFor()`, and that is load-bearing rather than
    // tidy: the client stops at the first extension whose handler returns
    // true, and `serverDiagnosticsFor()` returns true for every publish.
    // Behind it, this would see only the publishes for files nobody has open,
    // which is the opposite of the set a code action is ever asked about.
    diagnosticContextCapture(serverId),
    toriCompletion(),
    hoverTooltips(),
    // Two of the library's four keymaps, and the array around them is not a
    // formatting choice.
    //
    // The client keeps a configured extension only if it is an array or carries
    // `.extension` (`lsp-client/dist/index.js:551`), and `keymap.of(...)` is a
    // bare `FacetProvider`, which is neither. Spread out of
    // `languageServerExtensions()` as a top-level entry it was therefore
    // *dropped*, and F12, ⇧F12, F2 and ⇧⌥F have never actually been bound here.
    // `commands.ts` advertises the first three as `sub:` labels, so wrapping it
    // is what makes those labels true.
    //
    // But only for the two Tori has no answer of its own to, because the other
    // two would each be a regression the moment the keymap started working:
    //
    //   - `formatKeymap` (⇧⌥F) runs the *server's* formatter. Tori's own
    //     `lsp-format` is on that chord already and tries the project's Biome
    //     or Prettier first, which is the better answer; and since CodeMirror
    //     honours `preventDefault` even when a command declines, the library's
    //     binding would swallow ⇧⌥F in every buffer with no server too - a
    //     stylesheet or a Markdown file, where the project formatter is the
    //     only formatter there is.
    //   - `renameKeymap` (F2) runs `renameSymbol`, whose `doRename` skips every
    //     file the user has not already opened, silently. `lspRename.ts` exists
    //     because of that. `CodeEditor` already binds F2 to Tori's rename at
    //     `Prec.highest`, so this would only ever be the fallback nobody wants.
    [keymap.of([...jumpToDefinitionKeymap, ...findReferencesKeymap])],
    signatureHelp(),
    serverDiagnosticsFor(serverId, peersOf),
    symbolClientCapabilities,
    semanticTokensClientCapabilities,
    callHierarchyClientCapabilities,
    codeLensClientCapabilities,
    workspaceEditClientCapabilities,
    codeActionClientCapabilities,
    completionClientCapabilities,
    configurationClientCapabilities,
    progressClientCapabilities,
  ];
}

function workspaceDeps(server: LspServer) {
  return {
    // Buffer before disk. A background tab is viewless and can hold unsaved
    // edits, so the filesystem is the wrong answer for exactly the files the
    // user is working on.
    bufferText: (path: string) => liveBufferText(path),
    diskText: (path: string) => invoke<string>("fs_read_file", { path }).catch(() => null),
    languageId: (path: string) => languageIdFor(server, path),
    requestOpen: (path: string) => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path }),
  };
}

// ------------------------------------------- the requests Tori answers

const SEMANTIC_REFRESH = "workspace/semanticTokens/refresh";
const CODE_LENS_REFRESH = "workspace/codeLens/refresh";
const APPLY_EDIT = "workspace/applyEdit";
const CONFIGURATION = "workspace/configuration";
const WORK_DONE_CREATE = "window/workDoneProgress/create";
const SHOW_MESSAGE_REQUEST = "window/showMessageRequest";

/**
 * One "a server says its own answers went stale" slot.
 *
 * Registered by the editor while it is mounted, and one slot rather than a list
 * for the reason `liveBuffers` has one: there is exactly one `CodeEditor`, and a
 * subscriber list is churn until there are two.
 *
 * Every such request carries the root of the session that sent it, because the
 * claim is that session's alone: in a monorepo, `packages/a`'s server going
 * stale says nothing about a file `packages/b`'s server answers for.
 */
function refreshSlot() {
  let listener: ((root: string) => void) | null = null;
  return {
    /** Subscribe. Returns an unregister that is guarded, because a later
     *  registration may already have replaced this one and clearing the slot
     *  then would unregister somebody else. */
    set(fn: (root: string) => void): () => void {
      listener = fn;
      return () => {
        if (listener === fn) listener = null;
      };
    },
    fire(root: string): void {
      listener?.(root);
    },
  };
}

const semanticRefresh = refreshSlot();
const codeLensRefresh = refreshSlot();

/** Be told when a server says its semantic tokens are stale.
 *
 *  Worth having because semantic colour is a property of the whole program, not
 *  of the file on screen: editing `types.ts` changes what a name in `main.ts`
 *  *means* without changing a character of it, so nothing the editor can observe
 *  locally would ever prompt the re-request. */
export const setSemanticRefreshListener = semanticRefresh.set;

/** Be told when a server says its code lenses are stale.
 *
 *  The same argument one step further: a reference count is a property of the
 *  whole program, so adding a call in `main.ts` changes the number drawn above a
 *  function in `types.ts` without touching that file at all. Nothing observable
 *  in the buffer on screen would ever prompt the re-request, which is what
 *  `workspace.codeLens.refreshSupport` exists to say. */
export const setCodeLensRefreshListener = codeLensRefresh.set;

/**
 * The server-initiated requests Tori answers, and the whole reason the router
 * exists. See `serverRequests.ts` for why the transport is the only seam where
 * this can be done at all.
 *
 * A handler answers `null` by returning nothing, which is what both of these
 * requests expect.
 */
const serverRequests = createRequestRouter<LspHandle>({
  [SEMANTIC_REFRESH]: (_params, handle) => {
    semanticRefresh.fire(handle.root);
  },
  // Answered rather than left to the library, which would reply `-32601` to a
  // request Tori's own capabilities invited. A conformant server reads that as
  // the client having lied and stops asking, so the lenses would then only ever
  // be as fresh as the next edit to the file they are drawn in.
  [CODE_LENS_REFRESH]: (_params, handle) => {
    codeLensRefresh.fire(handle.root);
  },
  [APPLY_EDIT]: (params, handle) =>
    answerApplyEdit(params, applyDepsFor(handle), (message) => emitWith<ToastEvent>(TOAST, { message, kind: "error" })),
  // Synchronous, which the router requires and this can honour: the answer is
  // a lookup in a config that was loaded at startup. A session that has gone
  // answers null for every section rather than throwing, since the request can
  // outlive the project it was asked about.
  [CONFIGURATION]: (params, handle) => configurationFor(sessions.get(key(handle))?.server.settings ?? null, params),
  // Nothing to set up: a token is tracked from its `begin`.
  [WORK_DONE_CREATE]: () => {},
  // A session already dropped has nobody left to clear its question.
  [SHOW_MESSAGE_REQUEST]: (params, handle) => {
    const session = sessions.get(key(handle));
    return session ? askServerQuestion(key(handle), session.server.label, params) : null;
  },
});

/**
 * What `applyWorkspaceEdit` needs, built from the session the request arrived
 * on rather than from whatever is on screen: a server can send an edit for a
 * file in a different package than the one the caret is in.
 *
 * Keyed by the whole handle, never by root alone. Two servers can resolve the
 * same root - both bundled configs list `.git` as a marker - and borrowing the
 * other one's workspace would materialise the edit's files into the wrong
 * server's document set and map positions through the wrong client.
 *
 * Null when that session is gone, which is a real state - a project switch
 * while the server was mid-command.
 */
function applyDepsFor(handle: LspHandle): ApplyDeps | null {
  const session = sessions.get(key(handle));
  if (session?.kind !== "primary") return null;
  const { client, workspace } = session;
  return {
    requestFile: (uri) => workspace.requestFile(uri) as Promise<MaterialisedFile | null>,
    retainMapping: () => workspace.retainMapping(),
    makeMapping: () => client.workspaceMapping() as unknown as Mapping,
    dirtyBuffers,
    adoptBufferText,
    writeFiles: writeFilesSuppressingEcho,
    notifyWritten: (paths) => {
      for (const p of paths) notifyLspFileChanged(p);
    },
    dispatch: (view, changes) => view.dispatch({ changes, userEvent: "lsp.applyEdit" }),
  };
}

// A secondary has no `ToriWorkspace`: its positions are in the doc it was last
// sent, carried onto the text the edit lands on, and a file it never opened was
// read from what the editor or the disk holds.
function secondaryApplyDeps(client: SecondaryClient, userEvent: string): ApplyDeps {
  const landing = new Map<string, Text>();
  return {
    requestFile: async (uri) => {
      const path = uriToPath(uri);
      if (!path) return null;
      const feed = feedFor(path);
      const text = feed
        ? null
        : (liveBufferText(path) ?? (await invoke<string>("fs_read_file", { path }).catch(() => null)));
      const doc = feed?.doc ?? (text === null ? null : toDoc(text));
      if (!doc) return null;
      landing.set(path, doc);
      return { uri, doc, getView: () => feedFor(path)?.view ?? null };
    },
    retainMapping: () => () => {},
    makeMapping: () => ({
      mapPosition: (uri, pos, assoc) => {
        const path = uriToPath(uri);
        const feed = path && feedFor(path);
        const doc = feed ? feed.doc : path && landing.get(path);
        if (!path || !doc) throw new Error(`${uri} was not read for this edit`);
        const held = client.held(path) ?? doc;
        const toNow = feed
          ? changesToNow(held, feed.synced, feed.unsynced.desc, doc)
          : changesToNow(held, doc, ChangeSet.empty(doc.length).desc, doc);
        const at = offsetIn(held, pos);
        if (at === null) throw new Error("the edit names no position");
        return toNow.mapPos(at, assoc);
      },
      destroy: () => {},
    }),
    dirtyBuffers,
    adoptBufferText,
    writeFiles: writeFilesSuppressingEcho,
    notifyWritten: (paths) => {
      for (const p of paths) notifyLspFileChanged(p);
    },
    dispatch: (view, changes) => view.dispatch({ changes, userEvent }),
  };
}

/** How to apply an edit from the secondary `serverId` on `path`, or null when
 *  no such server is live for it. */
export function secondaryEditDeps(path: string, serverId: string, userEvent: string): ApplyDeps | null {
  const session = secondariesFor(path).find((s) => s.server.id === serverId);
  return session ? secondaryApplyDeps(session.client, userEvent) : null;
}

/** Route one inbound frame, replying on the same session it arrived on.
 *  Returns whether the frame was consumed. */
function interceptServerRequest(handle: LspHandle, msg: string): boolean {
  return serverRequests(handle, msg, (message) => {
    void invoke("lsp_send", { handle, message }).catch(() => {});
  });
}

// Only for a live session: a frame still in the channel after its session was
// dropped would begin work that nothing ever ends.
function interceptProgress(handle: LspHandle, msg: string): boolean {
  return sessions.has(key(handle)) && trackProgress(handle, msg);
}

/** Tell every live workspace that a file changed outside its editor, so a
 *  headless snapshot does not go on describing a document that no longer
 *  exists. Cheap and harmless for a path no workspace has materialised. */
export function notifyLspFileChanged(path: string): void {
  // Caught rather than left to float: this runs a callback back into the editor
  // component, and an unhandled rejection is invisible - it does not fail a
  // test run, and here it would not fail the app either.
  for (const session of sessions.values()) {
    if (session.kind === "primary") {
      session.workspace.fileChanged(path).catch((e) => console.error("lsp fileChanged failed", path, e));
    } else if (liveBufferText(path) === null) {
      session.client.close(path);
    }
  }
  if (isActivationMarker(path)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    void reresolve(
      (file) => isUnderPath(file, dir),
      () => forgetResolutions(dir),
    );
  } else if (path.endsWith("/.tori/settings.json")) {
    lspSettingsChanged();
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
  serverId: string;
  /** Resolves once `initialize` has been answered, so `supports` is asking
   *  about capabilities that exist. Settles either way: a server that failed to
   *  initialize is not one to keep a caller waiting on. */
  ready: Promise<void>;
  /** Whether the server advertised this provider. False before `ready`, which
   *  is the honest answer: nothing has been advertised yet, and asking anyway
   *  is what draws a `MethodNotFound`. */
  supports: (capability: keyof ServerCapabilities) => boolean;
  /** What the server advertised, for the capabilities that carry data rather
   *  than a yes. `semanticTokensProvider` ships the legend naming what each
   *  token index means, and a token stream read without it is a list of
   *  integers. Undefined before `ready`, same as `supports` being false. */
  capability: <K extends keyof ServerCapabilities>(name: K) => ServerCapabilities[K] | undefined;
  /** Flush pending document changes. The library's own sync is debounced by
   *  500 ms, so a question about positions asked sooner than that would be
   *  answered against a document the server has not seen yet. */
  sync: () => void;
  request: <R>(method: string, params: unknown) => Promise<R>;
};

type ServerCapabilities = NonNullable<LSPClient["serverCapabilities"]>;

function targetOf(session: PrimarySession): LspTarget {
  return {
    root: session.handle.root,
    serverId: session.server.id,
    ready: session.client.initializing.then(
      () => {},
      () => {},
    ),
    supports: (capability) => !!session.client.serverCapabilities?.[capability],
    capability: (name) => session.client.serverCapabilities?.[name],
    sync: () => session.client.sync(),
    request: (method, params) => session.client.request(method, params),
  };
}

/** The server answering for `path`, or null when nothing does. Same
 *  longest-root rule as the plugin, so a question about a file reaches the
 *  server holding that file's compiler config. */
export function lspTargetFor(path: string): LspTarget | null {
  const session = answeringSession(path);
  return session ? targetOf(session) : null;
}

function secondaryTargetOf(session: SecondarySession, path: string): LspTarget {
  const { client } = session;
  return {
    root: session.handle.root,
    serverId: session.server.id,
    ready: client.initializing,
    supports: (capability) => !!client.capability(capability),
    capability: (name) => client.capability(name) as ServerCapabilities[typeof name] | undefined,
    sync: () => feedFor(path)?.flush(),
    request: (method, params) => client.request(method, params),
  };
}

/** Every live server on `path` whose config lets it be asked for `feature`,
 *  the primary first. */
export function lspTargetsFor(path: string, feature: LspFeature): LspTarget[] {
  const primary = answeringSession(path);
  return [
    ...(primary?.server.features.includes(feature) ? [targetOf(primary)] : []),
    ...secondariesFor(path)
      .filter((s) => s.server.features.includes(feature))
      .map((s) => secondaryTargetOf(s, path)),
  ];
}

/** Every live server. What a workspace-wide question asks: `workspace/symbol`
 *  is scoped to one server's own root, so a monorepo with a package-level
 *  session and a repo-root session has to ask both to see the whole tree. */
export function lspTargets(): LspTarget[] {
  return [...sessions.values()].flatMap((s) => (s.kind === "primary" ? [targetOf(s)] : []));
}

/**
 * Run one of the server's own commands.
 *
 * The other half of a code action: an action that arrives carrying a `command`
 * instead of an `edit` has nowhere to run without this, and the way a server
 * usually answers one is by pushing a `workspace/applyEdit` straight back at
 * us - which the router above is what answers.
 *
 * Null when the server offers no `executeCommandProvider`, the same
 * "asked and refused" that the symbol surfaces return, so a caller can tell it
 * apart from a command that genuinely answered nothing.
 */
export async function executeServerCommand(target: LspTarget, command: string, args?: unknown[]): Promise<unknown> {
  await target.ready;
  if (!target.supports("executeCommandProvider")) return null;
  return target.request("workspace/executeCommand", { command, arguments: args });
}

/** Tear down every client and stop every server. What app teardown calls; a
 *  project switch retires instead (`lspWarmRoots`), so servers stay warm. */
export async function stopAllLsp(): Promise<void> {
  generation += 1;
  dropAllSessions();
  starting.clear();
  clearWarmRoots();
  await invoke("lsp_stop_all").catch(() => {});
}

/** Stop the servers of projects that fell off the warm end.
 *
 *  The touch itself is `lspWarmRoots`, and the split is not tidiness: a project
 *  switch is the one caller that reaches this module through a dynamic import,
 *  and this module is in a cycle, so that import can resolve before a single
 *  statement of the body has run. Touching the LRU from here read module-scope
 *  bindings in their temporal dead zone and threw on every switch. The touch is
 *  now done in a module with no cycle to be caught in, and this is asked for
 *  only when something was actually evicted, which is rare and by then late. */
export async function stopEvictedLspRoots(roots: readonly string[]): Promise<void> {
  for (const root of roots) await stopLspUnder(root);
}

/** Stop the sessions of one evicted project, and drop what they published: the
 *  Problems store and the code-action context would otherwise keep describing
 *  files of a project whose servers are gone. */
async function stopLspUnder(projectPath: string): Promise<void> {
  const doomed = [...sessions.values()].filter(
    (s) => s.handle.root === projectPath || isUnderPath(s.handle.root, projectPath),
  );
  for (const session of doomed) void stopSession(session);
  dropDiagnosticsUnder(projectPath);
  dropDiagnosticContextUnder(`${pathToUri(projectPath)}/`);
  if (doomed.length) notify();
}

function stopSession(session: Session): Promise<void> {
  dropSession(session);
  return invoke("lsp_stop", { handle: session.handle }).then(
    () => {},
    () => {},
  );
}

function dropSession(session: Session): void {
  try {
    session.client.disconnect();
  } catch {
    // ignore
  }
  sessions.delete(key(session.handle));
  clearProgress(session.handle);
  dropServerQuestions(key(session.handle));
  if (session.kind === "secondary") for (const path of session.client.openPaths()) retract(session.server.id, path);
}

type LspExited = { handle: LspHandle; status: string | null; deliberate: boolean };

let exits: Promise<unknown> | null = null;

// Awaited before a start, so a server that dies on launch cannot report it
// before anyone is listening.
function watchExits(): Promise<unknown> {
  exits ??= listen<LspExited>("lsp://exited", (e) => onExited(e.payload)).catch(() => {});
  return exits;
}

// A server can die between `lsp_start` answering and its client being built, and
// its exit then finds no session. Cleared per server before each start, so a
// crash nobody was waiting on is never pinned on a later process.
const diedEarly = new Set<string>();

// No restart of its own: a server that dies during `initialize` would go round
// for as long as the app stayed open.
function onExited({ handle, deliberate }: LspExited): void {
  if (deliberate) return;
  const session = sessions.get(key(handle));
  if (!session) {
    diedEarly.add(key(handle));
    return;
  }
  if (session.kind === "primary") retractPrimary(session);
  dropSession(session);
  notify();
  toastCrash(session.server, handle, session.origin);
}

function toastCrash(server: LspServer, handle: LspHandle, origin: Origin): void {
  emitWith<ToastEvent>(TOAST, {
    message: `${server.label} stopped`,
    action: [
      { label: "Restart", run: () => void restart(server, origin) },
      { label: "Show log", run: () => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: lspLogTabId(handle) }) },
    ],
  });
}

// Before the client disconnects, which is what still knows the files it had
// open. A buffer with no view keeps its lint state out of reach, so its Problems
// entry is dropped instead, as `reresolve` does.
function retractPrimary(session: PrimarySession): void {
  const shown = new Set<string>();
  for (const file of session.workspace.files) {
    rememberDiagnostics(file.uri, session.server.id, []);
    const view = file.getView();
    const path = uriToPath(file.uri);
    if (!view || !path) continue;
    shown.add(path);
    view.dispatch(publishFrom(view.state, session.server.id, [], peersOf(path)));
  }
  for (const path of requested.keys()) {
    if (!shown.has(path) && answeringSession(path) === session) dropDiagnostics(path);
  }
}

/** Per-buffer editor extension for a file whose server is up, empty for
 *  anything else: an unclaimed extension, a file outside every live root, or a
 *  server that has not come up yet. Empty-while-starting is why callers hold
 *  this in a compartment and reconfigure on `onLspChange` rather than baking
 *  the result into the buffer's state. */
export function lspPluginFor(path: string): Extension {
  const claim = claimFor(path);
  const primary = claim ? claim.session.client.plugin(pathToUri(path), claim.languageId) : [];
  if (!feedTargets(path).length) return primary;
  return [primary, secondaryFeed.of({ path, targets: () => feedTargets(path) })];
}

// Each secondary the file's resolution names, at the longest root holding it.
// Unresolved (the cache is cleared while a change re-resolves), every live one
// claiming the file, as `answeringSession` does for a primary.
function secondariesFor(path: string): SecondarySession[] {
  if (keptFromServers(path)) return [];
  const ids = resolvedServerIds(path);
  const found = new Map<string, SecondarySession>();
  for (const session of sessions.values()) {
    if (session.kind !== "secondary" || !isUnderPath(path, session.handle.root)) continue;
    if (ids ? !ids.includes(session.server.id) : !languageIdFor(session.server, path)) continue;
    const best = found.get(session.server.id);
    if (!best || session.handle.root.length > best.handle.root.length) found.set(session.server.id, session);
  }
  return [...found.values()];
}

function feedTargets(path: string): FeedTarget[] {
  return secondariesFor(path).flatMap((s) => {
    const languageId = languageIdFor(s.server, path);
    return languageId ? [{ client: s.client, languageId }] : [];
  });
}

/** The live servers whose diagnostics a file shows. */
function peersOf(path: string): string[] {
  const primary = answeringSession(path);
  return [...(primary ? [primary.server.id] : []), ...secondariesFor(path).map((s) => s.server.id)];
}

function showSecondaryDiagnostics(serverId: string, client: SecondaryClient, publish: Publish): void {
  const { uri, path, version, diagnostics } = publish;
  rememberDiagnostics(uri, serverId, diagnostics);
  const feed = feedFor(path);
  const held = client.held(path);
  const since = client.since(path, version);
  if (!feed || !held || !since) return;
  const toNow = since.changes.composeDesc(changesToNow(held, feed.synced, feed.unsynced.desc, feed.doc));
  const list = toEditorDiagnostics(diagnostics, since.doc, toNow, serverId);
  feed.view.dispatch(publishFrom(feed.view.state, serverId, list, peersOf(path)));
}

// Take a server's diagnostics off a file it no longer answers for.
function retract(serverId: string, path: string): void {
  rememberDiagnostics(pathToUri(path), serverId, []);
  const feed = feedFor(path);
  if (feed) feed.view.dispatch(publishFrom(feed.view.state, serverId, [], peersOf(path)));
}

/** The session and language id that will answer for `path`, or null.
 *
 *  One guard chain behind both the plugin and `claimedByLsp`, so what a buffer
 *  actually got and what the completion fallback believes it got cannot drift
 *  apart. Splitting them was how a file could end up with the server's
 *  completions and the scraped-word list at the same time. */
function claimFor(path: string): { session: PrimarySession; languageId: string } | null {
  const session = answeringSession(path);
  if (!session) return null;
  const languageId = languageIdFor(session.server, path);
  if (!languageId) return null;
  return { session, languageId };
}

// Resolved, the file's own primary answers. Unresolved (a call hierarchy item
// in a file nobody opened), the longest-root session of any primary claiming
// the extension does, which is what every file got before resolution existed.
// A buffer kept from servers gets none: too big to send, or not the file's text.
function answeringSession(path: string): PrimarySession | null {
  if (keptFromServers(path)) return null;
  const resolved = resolvedPrimary(path);
  const candidates = resolved === undefined ? primariesClaiming(path) : resolved ? [resolved] : [];
  let best: PrimarySession | null = null;
  for (const server of candidates) {
    const session = sessionFor(path, server);
    if (session?.kind !== "primary") continue;
    if (!best || session.handle.root.length > best.handle.root.length) best = session;
  }
  return best;
}

/**
 * Whether a live language server has taken this buffer on.
 *
 * Answers about *now*, not about the file type: it is false while the server is
 * still starting, and false again if a project switch takes it away. That is
 * what `fallbackCompletion.ts` reads, so a buffer opened before the server was
 * ready is not left with no completion at all, and gives the scraped words up
 * the moment the server does claim the file (`onLspChange`).
 */
export function claimedByLsp(path: string): boolean {
  return claimFor(path) !== null;
}
