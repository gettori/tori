// A language server running beside the one that owns a file. Not a second
// `LSPClient`: the library binds one plugin per view, and `ToriWorkspace` reads
// that plugin's change tracking, so a second client would steal the primary's.

import { ChangeSet, type ChangeDesc, type Text } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { diffChanges } from "./docDiff";
import { configurationClientCapabilities, configurationFor } from "./lspConfiguration";
import type { RawDiagnostic } from "./lspDiagnosticContext";
import { createRequestRouter } from "./serverRequests";
import { pathToUri, uriToPath } from "./toriWorkspace";
import { VersionTrail } from "./versionTrail";

export type SecondaryOptions = {
  send: (message: string) => void;
  rootUri: string;
  timeoutMs: number;
  settings: Record<string, unknown> | null;
  initializationOptions: unknown;
  onDiagnostics: (publish: Publish) => void;
};

export type Publish = { uri: string; path: string; version: number | null; diagnostics: RawDiagnostic[] };

// `pulled` is the newest version a pull has reported on, so a slow answer for an
// older one cannot replace it.
type OpenDoc = { uri: string; version: number; doc: Text; trail: VersionTrail; pulled: number };

type Frame = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

// Both ways of getting diagnostics: the ESLint server only answers pulls.
const CAPABILITIES = {
  textDocument: { publishDiagnostics: { versionSupport: true }, diagnostic: { dynamicRegistration: false } },
  workspace: { ...configurationClientCapabilities.clientCapabilities.workspace, diagnostics: { refreshSupport: true } },
};

const METHOD_NOT_FOUND = -32601;

function notification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

// Positions are taken in `prev` and the list is sent last change first, so each
// range is still valid when the server applies it.
function incrementalChanges(prev: Text, changes: ChangeSet) {
  const events: { range: unknown; text: string }[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const start = prev.lineAt(fromA);
    const end = prev.lineAt(toA);
    events.push({
      range: {
        start: { line: start.number - 1, character: fromA - start.from },
        end: { line: end.number - 1, character: toA - end.from },
      },
      text: inserted.toString(),
    });
  });
  return events.reverse();
}

// Answered, not refused: a -32601 tells the server the client lied about its
// capabilities, and the ESLint server reports an unanswered `eslint/*` request
// as a failure to the user.
const answerRequest = createRequestRouter<SecondaryClient>({
  "client/registerCapability": () => {},
  "client/unregisterCapability": () => {},
  "window/workDoneProgress/create": () => {},
  "workspace/configuration": (params, client) => configurationFor(client.settings, params),
  "workspace/diagnostic/refresh": (_params, client) => client.pullAll(),
  "eslint/*": () => {},
});

export class SecondaryClient {
  readonly initializing: Promise<void>;
  readonly settings: Record<string, unknown> | null;
  private capabilities: { textDocumentSync?: unknown; diagnosticProvider?: unknown } | null = null;
  // Built at flush rather than at post, so a change queued before `initialize`
  // is answered is still encoded the way the server asked for.
  private outbox: (() => string | null)[] | null = [];
  private docs = new Map<string, OpenDoc>();
  private pending = new Map<number, { settle: (frame: Frame) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private closed = false;

  constructor(private opts: SecondaryOptions) {
    this.settings = opts.settings;
    this.initializing = this.call("initialize", {
      processId: null,
      clientInfo: { name: "tori" },
      rootUri: opts.rootUri,
      capabilities: CAPABILITIES,
      initializationOptions: opts.initializationOptions ?? undefined,
    }).then(
      (result) => {
        this.capabilities = (result as { capabilities?: SecondaryClient["capabilities"] } | null)?.capabilities ?? {};
        opts.send(notification("initialized", {}));
        if (opts.settings) opts.send(notification("workspace/didChangeConfiguration", { settings: opts.settings }));
        const queued = this.outbox ?? [];
        this.outbox = null;
        for (const build of queued) {
          const message = build();
          if (message) opts.send(message);
        }
      },
      () => this.disconnect(),
    );
  }

  /** Bring the server's copy of `path` to `now`, opening it when it has none.
   *  `base` is the caller's own record of the changes since an earlier doc, used
   *  when that is the doc the server holds. */
  sync(path: string, languageId: string, now: Text, base?: { doc: Text; changes: ChangeSet }): void {
    if (this.closed) return;
    const open = this.docs.get(path);
    if (!open) {
      const uri = pathToUri(path);
      const trail = new VersionTrail();
      trail.record(0, now, null);
      this.docs.set(path, { uri, version: 0, doc: now, trail, pulled: -1 });
      this.post(() =>
        notification("textDocument/didOpen", { textDocument: { uri, languageId, version: 0, text: now.toString() } }),
      );
      void this.initializing.then(() => this.pull(path));
      return;
    }
    if (open.doc === now) return;
    const changes = base?.doc === open.doc ? base.changes : open.doc.eq(now) ? null : diffChanges(open.doc, now);
    const prev = open.doc;
    open.doc = now;
    if (!changes) return;
    open.version += 1;
    open.trail.record(open.version, now, changes);
    const { uri, version } = open;
    this.post(() => {
      const sync = this.capabilities?.textDocumentSync;
      const kind = typeof sync === "number" ? sync : ((sync as { change?: number } | undefined)?.change ?? 0);
      if (kind === 0) return null;
      const contentChanges = kind === 2 ? incrementalChanges(prev, changes) : [{ text: now.toString() }];
      return notification("textDocument/didChange", { textDocument: { uri, version }, contentChanges });
    });
    void this.initializing.then(() => this.pull(path));
  }

  /** Ask again for every open file, which is what a server's refresh wants. */
  pullAll(): void {
    for (const path of this.docs.keys()) this.pull(path);
  }

  private pull(path: string): void {
    const open = this.docs.get(path);
    if (!open || this.closed || !this.capabilities?.diagnosticProvider) return;
    const { uri, version } = open;
    this.call("textDocument/diagnostic", { textDocument: { uri } }).then(
      (report) => {
        const { kind, items } = (report ?? {}) as { kind?: unknown; items?: unknown };
        if (kind !== "full" || !Array.isArray(items) || this.docs.get(path) !== open || version < open.pulled) return;
        open.pulled = version;
        this.opts.onDiagnostics({ uri, path, version, diagnostics: items as RawDiagnostic[] });
      },
      (e) => {
        if (!this.closed) console.error("textDocument/diagnostic failed", path, e);
      },
    );
  }

  close(path: string): void {
    const open = this.docs.get(path);
    if (!open) return;
    this.docs.delete(path);
    if (!this.closed) this.post(() => notification("textDocument/didClose", { textDocument: { uri: open.uri } }));
  }

  openPaths(): string[] {
    return [...this.docs.keys()];
  }

  /** What the server was last sent for `path`. */
  held(path: string): Text | null {
    return this.docs.get(path)?.doc ?? null;
  }

  since(path: string, version: number | null): { doc: Text; changes: ChangeDesc } | null {
    return this.docs.get(path)?.trail.since(version) ?? null;
  }

  receive(msg: string): void {
    if (this.closed) return;
    if (answerRequest(this, msg, this.opts.send)) return;
    let frame: Frame;
    try {
      frame = JSON.parse(msg) as Frame;
    } catch {
      return;
    }
    if (typeof frame.method !== "string") {
      if (typeof frame.id === "number") this.pending.get(frame.id)?.settle(frame);
    } else if (frame.id !== undefined) {
      const error = { code: METHOD_NOT_FOUND, message: "Method not implemented" };
      this.opts.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error }));
    } else if (frame.method === "textDocument/publishDiagnostics") {
      const p = frame.params as { uri?: unknown; version?: unknown; diagnostics?: unknown } | null;
      const uri = typeof p?.uri === "string" ? p.uri : null;
      const path = uri && uriToPath(uri);
      if (!uri || !path) return;
      this.opts.onDiagnostics({
        uri,
        path,
        version: typeof p?.version === "number" ? p.version : null,
        diagnostics: Array.isArray(p?.diagnostics) ? (p.diagnostics as RawDiagnostic[]) : [],
      });
    }
  }

  disconnect(): void {
    this.closed = true;
    this.outbox = null;
    for (const { settle } of [...this.pending.values()]) settle({ error: "disconnected" });
  }

  private post(build: () => string | null): void {
    if (this.closed) return;
    if (this.outbox) {
      this.outbox.push(build);
      return;
    }
    const message = build();
    if (message) this.opts.send(message);
  }

  private call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("disconnected"));
      const id = ++this.nextId;
      const settle = (frame: Frame) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (frame.error !== undefined) reject(frame.error);
        else resolve(frame.result);
      };
      const timer = setTimeout(() => settle({ error: "timed out" }), this.opts.timeoutMs);
      this.pending.set(id, { settle, timer });
      this.opts.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
}

export type FeedTarget = { client: SecondaryClient; languageId: string };

// Same debounce as the library's own sync for the primary.
const SYNC_DELAY_MS = 500;

class Feed {
  synced: Text;
  unsynced: ChangeSet;
  // The doc `unsynced` leads to. Not `view.state.doc`: a reconfigure that lands
  // with an edit destroys this plugin with the new doc already in the view.
  doc: Text;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly view: EditorView,
    private spec: { path: string; targets: () => FeedTarget[] },
  ) {
    this.doc = this.synced = view.state.doc;
    this.unsynced = ChangeSet.empty(this.doc.length);
    feeds.set(spec.path, this);
    for (const t of spec.targets()) t.client.sync(spec.path, t.languageId, this.doc);
  }

  update(u: ViewUpdate): void {
    if (!u.docChanged) return;
    this.unsynced = this.unsynced.compose(u.changes);
    this.doc = u.state.doc;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SYNC_DELAY_MS);
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.doc === this.synced) return;
    for (const t of this.spec.targets()) {
      t.client.sync(this.spec.path, t.languageId, this.doc, { doc: this.synced, changes: this.unsynced });
    }
    this.synced = this.doc;
    this.unsynced = ChangeSet.empty(this.doc.length);
  }

  destroy(): void {
    this.flush();
    if (feeds.get(this.spec.path) === this) feeds.delete(this.spec.path);
  }
}

const feeds = new Map<string, Feed>();

export function feedFor(path: string): Feed | null {
  return feeds.get(path) ?? null;
}

export const secondaryFeed = ViewPlugin.define(
  (view, spec: { path: string; targets: () => FeedTarget[] }) => new Feed(view, spec),
);
