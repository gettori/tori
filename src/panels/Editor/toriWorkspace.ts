// The `Workspace` the language client sees, which is what makes any LSP
// operation that spans files work at all.
//
// The library's `DefaultWorkspace` only knows files that have a live
// `EditorView`, so `displayFile` (`getFile(uri)?.getView()`) returns null for
// everything else and go-to-definition into an unopened file is a silent no-op.
// See [[gotchas#lsp-client-assumes-one-editor-view-per-file]].
//
// Tori has three kinds of file, and the whole class is shaped by the third:
//
//   1. **view-backed** - the one tab on screen. Its changes reach the server the
//      library's way, through the plugin's `unsyncedChanges`.
//   2. **headless** - materialised by `requestFile` because the server asked
//      about a file the user never opened. It has a document and no view.
//   3. **background buffers** - a Tori tab that is open but not shown. It has no
//      view either (one `EditorView`, many `EditorState`s), it can be *dirty*,
//      and its unsaved text exists on no disk. Reading such a file from disk
//      would answer with text the user cannot see, so `requestFile` asks the
//      editor for its buffer text before it ever touches the filesystem.
//
// A background buffer cannot be typed into (typing needs a view), so a snapshot
// taken when it left the screen stays accurate until the file changes
// underneath it. `fileChanged` is what covers that last case.

import { ChangeSet, Text, type ChangeDesc } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LSPPlugin, Workspace, type LSPClient, type WorkspaceFile } from "@codemirror/lsp-client";
import { diffChanges, toDoc } from "./docDiff";
import { VersionTrail } from "./versionTrail";

// The library declares this shape but does not export it, so it is read back
// off the method that returns it rather than restated here, where it could
// drift.
type WorkspaceFileUpdate = ReturnType<Workspace["syncFiles"]>[number];

// The two collections a `WorkspaceMapping` builds in its constructor, and the
// client's list of live ones. All `@internal`, and all read defensively - see
// `joinActiveMappings` for why there is no supported alternative.
type ClientInternals = {
  activeMappings?: { mappings: Map<string, unknown>; startDocs: Map<string, Text> }[];
};

/** `file://` URI for an absolute path, percent-encoding each segment. */
export function pathToUri(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

/** The absolute path behind a `file://` URI, or null for anything else.
 *
 *  Servers do not all encode a URI the way `pathToUri` does (`vscode-uri`
 *  leaves several characters this escapes), so nothing here is ever keyed on
 *  the URI string. Decoding to a path first is what makes the two spellings of
 *  one file the same file. */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null; // a malformed escape, so this is not a path we can address
  }
}

class ToriFile implements WorkspaceFile {
  /** The live view, or null when this file is headless. */
  view: EditorView | null = null;
  /** A change the server has not been told about yet, reported by the next
   *  `syncFiles`. `changes` maps `this.doc` onto `doc`. */
  pending: { changes: ChangeSet; doc: Text } | null = null;
  readonly trail = new VersionTrail();

  constructor(
    readonly uri: string,
    /** The path behind `uri`, which is what the workspace keys everything on. */
    readonly path: string,
    public languageId: string,
    public version: number,
    public doc: Text,
  ) {
    this.trail.record(version, doc, null);
  }

  getView(): EditorView | null {
    return this.view;
  }
}

export type WorkspaceDeps = {
  /** The editor's text for `path`, live view or background buffer, or null when
   *  no buffer holds it. Always consulted before `diskText`. */
  bufferText: (path: string) => string | null;
  /** On-disk text, or null when the file cannot be read. */
  diskText: (path: string) => Promise<string | null>;
  /** The LSP language id this server uses for `path`, or null when it claims
   *  no such extension. */
  languageId: (path: string) => string | null;
  /** Ask the app to put `path` in front of the user. */
  requestOpen: (path: string) => void;
  maxHeadless?: number;
  displayTimeoutMs?: number;
};

/** How many headless snapshots to hold. Each one is a full document kept in
 *  memory here and open on the server; a find-references over a large project
 *  would otherwise materialise the whole tree and never let go. */
export const DEFAULT_MAX_HEADLESS = 100;
/** How long `displayFile` waits for the editor to actually show a file. Long
 *  enough for a cold open (read plus a language chunk import), short enough
 *  that a jump into a file the editor refuses to open ends in a null rather
 *  than a promise nobody ever settles. */
export const DEFAULT_DISPLAY_TIMEOUT_MS = 5000;

export class ToriWorkspace extends Workspace {
  files: ToriFile[] = [];

  private byPath = new Map<string, ToriFile>();
  private versions = new Map<string, number>();
  /** Headless paths, least recently used first. */
  private headless: string[] = [];
  private loading = new Map<string, Promise<WorkspaceFile | null>>();
  private waiting = new Map<string, ((view: EditorView | null) => void)[]>();
  /** Live `WorkspaceMapping` count. See `retainMapping`. */
  private retained = 0;
  /** Files whose removal was deferred because a mapping was live. */
  private deferred = new Set<string>();

  constructor(
    client: LSPClient,
    private deps: WorkspaceDeps,
  ) {
    super(client);
  }

  private get maxHeadless(): number {
    return this.deps.maxHeadless ?? DEFAULT_MAX_HEADLESS;
  }

  private nextVersion(path: string): number {
    const v = (this.versions.get(path) ?? -1) + 1;
    this.versions.set(path, v);
    return v;
  }

  /** Overrides the default linear scan, and canonicalises the URI on the way
   *  in: the server's spelling of a path need not be ours. */
  getFile(uri: string): WorkspaceFile | null {
    const path = uriToPath(uri);
    return (path && this.byPath.get(path)) || null;
  }

  /** The text the server was sent as `version` of `uri`, and the changes from
   *  it to the latest it was sent. */
  since(uri: string, version: number | null): { doc: Text; changes: ChangeDesc } | null {
    const path = uriToPath(uri);
    return (path && this.byPath.get(path)?.trail.since(version)) || null;
  }

  // --- Change reporting ----------------------------------------------------

  syncFiles(): readonly WorkspaceFileUpdate[] {
    const result: WorkspaceFileUpdate[] = [];
    for (const file of this.files) {
      const view = file.getView();
      const plugin = view ? LSPPlugin.get(view) : null;
      if (file.pending) {
        // A whole-document replacement outranks whatever the plugin has
        // accumulated: `pending` is only ever set when the file was headless,
        // so the plugin (if one exists at all) was created after the fact and
        // its changes are already inside `pending.doc`.
        const { changes, doc } = file.pending;
        file.pending = null;
        plugin?.clear();
        result.push({ changes, file, prevDoc: file.doc });
        file.doc = doc;
        file.version = this.nextVersion(file.path);
        file.trail.record(file.version, doc, changes);
        continue;
      }
      if (!view || !plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (changes.empty) continue;
      result.push({ changes, file, prevDoc: file.doc });
      file.doc = view.state.doc;
      file.version = this.nextVersion(file.path);
      file.trail.record(file.version, file.doc, changes);
      plugin.clear();
    }
    return result;
  }

  /**
   * A file changed underneath us: an agent wrote it, a checkpoint reverted it,
   * the watcher noticed an external edit.
   *
   * Only headless files need this. A view-backed file's changes already reach
   * the server through `syncFiles`, and this would report them twice. Without
   * it a headless snapshot silently rots: the server holds text matching
   * neither the disk nor the buffer, and every position it answers with is
   * measured against a document that no longer exists.
   */
  async fileChanged(path: string): Promise<void> {
    const file = this.byPath.get(path);
    if (!file || file.view) return;
    const text = this.deps.bufferText(path) ?? (await this.deps.diskText(path));
    // Re-read after the await: the file may have been shown, or evicted, while
    // we were reading it.
    const now = this.byPath.get(path);
    if (now !== file || file.view) return;
    if (text == null) {
      this.remove(path);
      return;
    }
    const doc = toDoc(text);
    // Compare against what the *next* sync will leave behind, so a second
    // change during one burst is not mistaken for a no-op.
    if ((file.pending?.doc ?? file.doc).eq(doc)) return;
    // Always relative to `file.doc`, the version the server holds, so replacing
    // an unsynced `pending` stays correct rather than composing onto it.
    file.pending = { changes: diffChanges(file.doc, doc), doc };
  }

  // --- Opening and closing -------------------------------------------------

  openFile(uri: string, languageId: string, view: EditorView): void {
    const path = uriToPath(uri);
    if (!path) return;
    const existing = this.byPath.get(path);
    if (existing) {
      const wasHeadless = !existing.view;
      // Tori has one `EditorView` and swaps its state, so a second view on one
      // file cannot happen today; if it ever does, the newest wins rather than
      // throwing the way `DefaultWorkspace` does.
      existing.view = view;
      existing.languageId = languageId;
      this.dropHeadless(path);
      if (wasHeadless && !(existing.pending?.doc ?? existing.doc).eq(view.state.doc)) {
        // The snapshot the server holds is not what the editor is showing: the
        // file was materialised from disk and the buffer had unsaved edits, or
        // it changed between the two. Report it rather than letting the editor
        // and the server disagree about a file that is now on screen.
        existing.pending = { changes: diffChanges(existing.doc, view.state.doc), doc: view.state.doc };
      }
      this.resolveWaiters(path, view);
      return;
    }
    const file = new ToriFile(uri, path, languageId, this.nextVersion(path), view.state.doc);
    file.view = view;
    this.add(path, file);
    this.client.didOpen(file);
    this.resolveWaiters(path, view);
  }

  /**
   * The view stopped holding this file. It becomes headless rather than closed:
   * a Tori tab that leaves the screen keeps its buffer, unsaved edits included,
   * and telling the server to forget it would make every later question about
   * it answer from disk instead.
   */
  closeFile(uri: string, view: EditorView): void {
    const path = uriToPath(uri);
    if (!path) return;
    const file = this.byPath.get(path);
    if (!file || file.view !== view) return;
    const plugin = LSPPlugin.get(view);
    if (plugin && !plugin.unsyncedChanges.empty) {
      // Carry the edits made while it was on screen across the transition, so
      // the next sync still reports them.
      file.pending = { changes: plugin.unsyncedChanges, doc: view.state.doc };
      plugin.clear();
    }
    file.view = null;
    this.touchHeadless(path);
    this.sweep();
  }

  /**
   * Materialise a file the server asked about.
   *
   * Buffer before disk: a dirty background tab is viewless, unsaved, and absent
   * from anything `savedText` knows, so reading it from disk would hand the
   * server a stale copy of a file the user is actively editing.
   */
  requestFile(uri: string): Promise<WorkspaceFile | null> {
    const path = uriToPath(uri);
    if (!path) return Promise.resolve(null);
    const existing = this.byPath.get(path);
    if (existing) {
      this.touchHeadless(path);
      return Promise.resolve(existing);
    }
    // Two references to one unopened file arrive together far more often than
    // not; without this they would each read it and each `didOpen` it.
    const inFlight = this.loading.get(path);
    if (inFlight) return inFlight;
    // The cleanup goes *outside* `load`, not in a `finally` within it. A
    // `finally` inside an async function whose body returns without ever
    // awaiting - an unclaimed extension, or text the buffer reader answers
    // synchronously - runs before the caller's next statement, so it would
    // delete the entry before the line below adds it and leave it there for
    // good. `.finally` on the returned promise is always a later microtask.
    const load = this.load(uri, path).finally(() => this.loading.delete(path));
    this.loading.set(path, load);
    return load;
  }

  private async load(uri: string, path: string): Promise<WorkspaceFile | null> {
    const languageId = this.deps.languageId(path);
    if (!languageId) return null; // this server claims no such extension
    const text = this.deps.bufferText(path) ?? (await this.deps.diskText(path));
    if (text == null) return null;
    // The editor may have opened it while we were reading.
    const now = this.byPath.get(path);
    if (now) return now;
    const file = new ToriFile(uri, path, languageId, this.nextVersion(path), toDoc(text));
    this.add(path, file);
    this.touchHeadless(path);
    this.client.didOpen(file);
    this.sweep();
    return file;
  }

  /**
   * Put a file in front of the user and hand back the view showing it, which is
   * what `jumpToDefinition` and the reference panel navigate with.
   *
   * Resolves when the editor reports the open through `openFile`, rather than
   * on a guess about how long that takes: the open reads the file and may await
   * a language chunk import first.
   */
  displayFile(uri: string): Promise<EditorView | null> {
    const path = uriToPath(uri);
    if (!path) return Promise.resolve(null);
    const shown = this.byPath.get(path)?.getView();
    if (shown) return Promise.resolve(shown);
    this.deps.requestOpen(path);
    return new Promise((resolve) => {
      const settle = (view: EditorView | null) => {
        clearTimeout(timer);
        const list = (this.waiting.get(path) ?? []).filter((w) => w !== settle);
        if (list.length) this.waiting.set(path, list);
        else this.waiting.delete(path);
        resolve(view);
      };
      const timer = setTimeout(() => settle(null), this.deps.displayTimeoutMs ?? DEFAULT_DISPLAY_TIMEOUT_MS);
      this.waiting.set(path, [...(this.waiting.get(path) ?? []), settle]);
    });
  }

  /** The client lost its transport, so nothing is ever going to open. */
  disconnected(): void {
    for (const list of [...this.waiting.values()]) for (const settle of list) settle(null);
    this.waiting.clear();
  }

  // --- Headless lifecycle --------------------------------------------------

  /**
   * Hold headless files in place while a `WorkspaceMapping` is live, and return
   * the release.
   *
   * A mapping snapshots every file's document in its constructor and
   * `mapPosition` throws for any URI missing from that snapshot, so evicting a
   * file mid-operation turns a rename into an exception rather than a smaller
   * rename. Evictions that come due meanwhile are deferred, not dropped.
   */
  retainMapping(): () => void {
    this.retained += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retained -= 1;
      if (this.retained === 0) {
        for (const path of [...this.deferred]) this.remove(path);
        this.sweep();
      }
    };
  }

  private add(path: string, file: ToriFile): void {
    this.byPath.set(path, file);
    this.files = [...this.files, file];
    this.joinActiveMappings(file);
  }

  /**
   * Add a just-materialised file to any `WorkspaceMapping` that is already
   * running, so a position in it can be mapped.
   *
   * `findReferences` creates its mapping *before* it asks the workspace for a
   * single file, and the reference panel then calls `mapPosition(file.uri, …)`
   * when an entry is clicked. A mapping only knows the files that existed when
   * its constructor ran, and `mapPosition` throws for anything else - inside a
   * promise, so clicking a reference in a file that was not already open does
   * nothing at all and reports nothing. That is the whole cross-file half of
   * find-references.
   *
   * The library offers no hook for this, so the mapping's own two collections
   * are seeded here, exactly as its constructor would have. Everything is
   * guarded: if a future version of the library reshapes them, this quietly
   * does nothing and the panel is no worse off than it is without it.
   */
  private joinActiveMappings(file: ToriFile): void {
    const active = (this.client as unknown as ClientInternals).activeMappings;
    if (!Array.isArray(active)) return;
    for (const mapping of active) {
      if (!(mapping?.mappings instanceof Map) || !(mapping?.startDocs instanceof Map)) continue;
      if (mapping.startDocs.has(file.uri)) continue;
      mapping.mappings.set(file.uri, ChangeSet.empty(file.doc.length));
      mapping.startDocs.set(file.uri, file.doc);
    }
  }

  private remove(path: string): void {
    if (this.retained > 0) {
      this.deferred.add(path);
      return;
    }
    this.deferred.delete(path);
    const file = this.byPath.get(path);
    if (!file) return;
    // A file that came back on screen while its removal was deferred is no
    // longer a candidate: closing it would leave the visible tab LSP-less.
    if (file.view) return;
    this.byPath.delete(path);
    this.files = this.files.filter((f) => f !== file);
    this.dropHeadless(path);
    this.client.didClose(file.uri);
  }

  private touchHeadless(path: string): void {
    this.dropHeadless(path);
    this.headless.push(path);
  }

  private dropHeadless(path: string): void {
    const at = this.headless.indexOf(path);
    if (at >= 0) this.headless.splice(at, 1);
  }

  private sweep(): void {
    if (this.retained > 0) return;
    // Shifted before the remove, not by it: a path with no file behind it would
    // otherwise stay at the head of the list and spin here forever.
    while (this.headless.length > this.maxHeadless) {
      this.remove(this.headless.shift()!);
    }
  }

  private resolveWaiters(path: string, view: EditorView): void {
    const list = this.waiting.get(path);
    if (!list) return;
    this.waiting.delete(path);
    for (const w of list) w(view);
  }
}
