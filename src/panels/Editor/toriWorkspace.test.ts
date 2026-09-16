import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LSPClient } from "@codemirror/lsp-client";
import { ToriWorkspace, pathToUri, uriToPath, type WorkspaceDeps } from "./toriWorkspace";

// The workspace is the whole reason a cross-file LSP operation can work, and
// almost none of what it does is visible from the editor: it decides what text
// the server is told a file holds, and getting that wrong is silent - the
// server answers confidently with positions measured against a document nobody
// has. So the cases worth the most here are the ones where the obvious answer
// (read the file from disk) is the wrong one.

function docOf(text: string): Text {
  return Text.of(text.split(/\r\n?|\n/));
}

function fakeClient() {
  const opened: string[] = [];
  const closed: string[] = [];
  // Shaped like the client's own `@internal` list of live `WorkspaceMapping`s,
  // which is the only place a mapping's snapshot can be reached from.
  const activeMappings: { mappings: Map<string, unknown>; startDocs: Map<string, Text> }[] = [];
  const client = {
    didOpen: (f: { uri: string }) => opened.push(f.uri),
    didClose: (uri: string) => closed.push(uri),
    activeMappings,
  };
  return { client: client as unknown as LSPClient, opened, closed, activeMappings };
}

// Stands in for an `EditorView` carrying an `LSPPlugin`. `LSPPlugin.get(view)`
// is `view.plugin(lspPlugin)`, so returning our own object from `plugin()` is
// all it takes to exercise the view-backed path without CodeMirror in jsdom.
function fakeView(text: string) {
  const v = {
    state: { doc: docOf(text) },
    plugin: () => v.lspPlugin,
    lspPlugin: {
      unsyncedChanges: ChangeSet.empty(0),
      clear() {
        v.lspPlugin.unsyncedChanges = ChangeSet.empty(v.state.doc.length);
      },
    },
    /** Simulate typing in this view, the way the real plugin accumulates. */
    edit(from: number, to: number, insert: string) {
      const changes = ChangeSet.of({ from, to, insert }, v.state.doc.length);
      v.lspPlugin.unsyncedChanges = v.lspPlugin.unsyncedChanges.compose(changes);
      v.state = { doc: changes.apply(v.state.doc) };
    },
  };
  v.lspPlugin.unsyncedChanges = ChangeSet.empty(v.state.doc.length);
  return v;
}

const asView = (v: ReturnType<typeof fakeView>) => v as unknown as EditorView;

function deps(over: Partial<WorkspaceDeps> = {}): WorkspaceDeps {
  return {
    bufferText: () => null,
    diskText: () => Promise.resolve(null),
    languageId: (path) => (path.endsWith(".ts") ? "typescript" : null),
    requestOpen: () => {},
    ...over,
  };
}

const A = "/repo/a.ts";
const B = "/repo/b.ts";

describe("file URIs", () => {
  it("round-trips a path with characters a URI has to escape", () => {
    const path = "/repo/my project/a b.ts";
    expect(uriToPath(pathToUri(path))).toBe(path);
  });

  it("reads a server's own encoding of a path back to the same path", () => {
    // `vscode-uri`, which most servers use, escapes a smaller set than
    // `encodeURIComponent` does. Nothing may be keyed on the URI string.
    expect(uriToPath("file:///repo/a%20b.ts")).toBe("/repo/a b.ts");
    expect(uriToPath("file:///repo/a+b.ts")).toBe("/repo/a+b.ts");
  });

  it("refuses anything that is not a file URI", () => {
    expect(uriToPath("untitled:Untitled-1")).toBeNull();
    expect(uriToPath("file:///bad/%zz.ts")).toBeNull();
  });
});

describe("ToriWorkspace open and close", () => {
  it("opens a file with the server exactly once", () => {
    const { client, opened, closed } = fakeClient();
    const ws = new ToriWorkspace(client, deps());
    const view = fakeView("const a = 1");

    ws.openFile(pathToUri(A), "typescript", asView(view));
    ws.openFile(pathToUri(A), "typescript", asView(view));

    expect(opened).toEqual([pathToUri(A)]);
    expect(closed).toEqual([]);
    expect(ws.files.length).toBe(1);
  });

  it("finds a file the server spelled differently", () => {
    const { client } = fakeClient();
    const ws = new ToriWorkspace(client, deps());
    ws.openFile(pathToUri("/repo/a b.ts"), "typescript", asView(fakeView("x")));

    expect(ws.getFile("file:///repo/a%20b.ts")).toBeTruthy();
  });

  it("keeps a closed tab's text instead of telling the server to forget it", () => {
    // A Tori tab that leaves the screen keeps its buffer, unsaved edits and
    // all. Closing it on the server would send every later question about the
    // file back to whatever is on disk.
    const { client, closed } = fakeClient();
    const ws = new ToriWorkspace(client, deps());
    const view = fakeView("const a = 1");
    const uri = pathToUri(A);

    ws.openFile(uri, "typescript", asView(view));
    view.edit(10, 11, "2");
    ws.closeFile(uri, asView(view));

    expect(closed).toEqual([]);
    expect(ws.getFile(uri)).toBeTruthy();
    // The edits made while it was on screen survive the transition.
    const [update] = ws.syncFiles();
    expect(update.file.doc.toString()).toBe("const a = 2");
  });

  it("ignores a close from a view that no longer holds the file", () => {
    const { client } = fakeClient();
    const ws = new ToriWorkspace(client, deps());
    const uri = pathToUri(A);
    const first = fakeView("one");
    const second = fakeView("two");

    ws.openFile(uri, "typescript", asView(first));
    ws.openFile(uri, "typescript", asView(second));
    ws.closeFile(uri, asView(first)); // the stale view's teardown, arriving late

    expect(ws.getFile(uri)?.getView()).toBe(asView(second));
  });
});

describe("ToriWorkspace syncFiles", () => {
  it("reports what was typed in the view, once", () => {
    const { client } = fakeClient();
    const ws = new ToriWorkspace(client, deps());
    const view = fakeView("const a = 1");
    ws.openFile(pathToUri(A), "typescript", asView(view));

    view.edit(6, 7, "b");
    const first = ws.syncFiles();
    expect(first.length).toBe(1);
    expect(first[0].prevDoc.toString()).toBe("const a = 1");
    expect(first[0].file.doc.toString()).toBe("const b = 1");
    expect(first[0].file.version).toBe(1);

    expect(ws.syncFiles()).toEqual([]);
  });
});

describe("ToriWorkspace requestFile", () => {
  it("prefers a dirty background buffer over the file on disk", async () => {
    // The case the whole class exists for: a viewless tab with unsaved edits.
    // Its text is in no view, on no disk, and in no backstop, so reading the
    // filesystem answers with a copy the user cannot see.
    const { client } = fakeClient();
    const ws = new ToriWorkspace(
      client,
      deps({
        bufferText: (p) => (p === A ? "const a = 2 // unsaved" : null),
        diskText: () => Promise.resolve("const a = 1"),
      }),
    );

    const file = await ws.requestFile(pathToUri(A));
    expect(file?.doc.toString()).toBe("const a = 2 // unsaved");
  });

  it("falls back to disk for a file no buffer holds", async () => {
    const { client, opened } = fakeClient();
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve("on disk") }));

    const file = await ws.requestFile(pathToUri(A));
    expect(file?.doc.toString()).toBe("on disk");
    expect(file?.languageId).toBe("typescript");
    expect(opened).toEqual([pathToUri(A)]);
  });

  it("returns null rather than materialising a file this server does not claim", async () => {
    const { client, opened } = fakeClient();
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve("x") }));

    expect(await ws.requestFile(pathToUri("/repo/notes.md"))).toBeNull();
    expect(opened).toEqual([]);
  });

  it("returns null for an unreadable file rather than an empty document", async () => {
    // An empty document would be a lie the server acts on: every symbol in the
    // file would read as deleted.
    const { client, opened } = fakeClient();
    const ws = new ToriWorkspace(client, deps());
    expect(await ws.requestFile(pathToUri(A))).toBeNull();
    expect(opened).toEqual([]);
  });

  it("does not cache a refusal for a file this server cannot claim yet", async () => {
    // The in-flight map is cleaned up from outside `load`, because a `finally`
    // inside an async function that returns without ever awaiting runs before
    // the caller has even recorded the entry - which would leave the refusal
    // cached for the rest of the session, so a server config added later never
    // took effect for those files.
    const { client } = fakeClient();
    let claims = false;
    const ws = new ToriWorkspace(
      client,
      deps({
        languageId: () => (claims ? "python" : null),
        diskText: () => Promise.resolve("print()"),
      }),
    );

    expect(await ws.requestFile(pathToUri("/repo/x.py"))).toBeNull();
    claims = true;
    expect((await ws.requestFile(pathToUri("/repo/x.py")))?.languageId).toBe("python");
  });

  it("does not hold an entry for a file the buffer answered synchronously", async () => {
    // Same shape, and the far more common one: the buffer reader returns text
    // without any await, so nothing after it is deferred either.
    const { client, closed } = fakeClient();
    const ws = new ToriWorkspace(
      client,
      deps({ bufferText: () => "in a buffer", maxHeadless: 1 }),
    );

    await ws.requestFile(pathToUri(A));
    await ws.requestFile(pathToUri(B));
    // A leaked entry would keep the evicted file's promise alive and hand it
    // back instead of materialising the file again.
    expect(closed).toEqual([pathToUri(A)]);
    expect((await ws.requestFile(pathToUri(A)))?.doc.toString()).toBe("in a buffer");
    expect(ws.getFile(pathToUri(A))).toBeTruthy();
  });

  it("reads a file once when two references to it arrive together", async () => {
    const { client, opened } = fakeClient();
    let reads = 0;
    const ws = new ToriWorkspace(
      client,
      deps({
        diskText: () => {
          reads += 1;
          return Promise.resolve("on disk");
        },
      }),
    );

    const [one, two] = await Promise.all([ws.requestFile(pathToUri(A)), ws.requestFile(pathToUri(A))]);
    expect(one).toBe(two);
    expect(reads).toBe(1);
    expect(opened).toEqual([pathToUri(A)]);
  });
});

describe("ToriWorkspace headless snapshots going stale", () => {
  it("reports a change to a file no editor is showing", async () => {
    const { client } = fakeClient();
    let disk = "const a = 1\nconst b = 2";
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve(disk) }));
    await ws.requestFile(pathToUri(A));

    disk = "// header\nconst a = 1\nconst b = 2";
    await ws.fileChanged(A);
    const [update] = ws.syncFiles();

    expect(update.file.doc.toString()).toBe(disk);
    // The point of reporting it as a change rather than a reopen: a position in
    // the old document still maps onto the new one. A snapshot left stale would
    // put every answer about this file off by the inserted line.
    const before = "const a = 1\nconst b = 2".indexOf("const b");
    expect(update.changes.mapPos(before)).toBe(disk.indexOf("const b"));
    expect(ws.syncFiles()).toEqual([]);
  });

  it("falls back to disk once the buffer behind a snapshot is gone", async () => {
    // Closing a tab without saving discards its unsaved edits, and the snapshot
    // taken while it was open still holds them. The editor reports the close
    // through the same route as any external change, and the buffer reader has
    // stopped answering for it by then, so this has to resolve to disk.
    const { client } = fakeClient();
    let inBuffer: string | null = "unsaved edits";
    const ws = new ToriWorkspace(
      client,
      deps({ bufferText: () => inBuffer, diskText: () => Promise.resolve("what is on disk") }),
    );
    await ws.requestFile(pathToUri(A));
    expect(ws.getFile(pathToUri(A))?.doc.toString()).toBe("unsaved edits");

    inBuffer = null;
    await ws.fileChanged(A);
    const [update] = ws.syncFiles();
    expect(update.file.doc.toString()).toBe("what is on disk");
  });

  it("survives a change that lands in the middle of a surrogate pair", async () => {
    // Two emoji share a leading code unit, so the naive common-prefix trim cuts
    // one character in half.
    const { client } = fakeClient();
    let disk = "const flag = \u{1F600}";
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve(disk) }));
    await ws.requestFile(pathToUri(A));

    disk = "const flag = \u{1F601}";
    await ws.fileChanged(A);
    const [update] = ws.syncFiles();

    expect(update.changes.apply(update.prevDoc).toString()).toBe(disk);
    expect(update.file.doc.toString()).toBe(disk);
  });

  it("leaves a file the editor is showing to the editor", async () => {
    // Reporting it here as well would send the same edit to the server twice.
    const { client } = fakeClient();
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve("from disk") }));
    ws.openFile(pathToUri(A), "typescript", asView(fakeView("in the view")));

    await ws.fileChanged(A);
    expect(ws.syncFiles()).toEqual([]);
    expect(ws.getFile(pathToUri(A))?.doc.toString()).toBe("in the view");
  });

  it("drops a snapshot of a file that is gone", async () => {
    const { client, closed } = fakeClient();
    let disk: string | null = "const a = 1";
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve(disk) }));
    await ws.requestFile(pathToUri(A));

    disk = null;
    await ws.fileChanged(A);

    expect(closed).toEqual([pathToUri(A)]);
    expect(ws.getFile(pathToUri(A))).toBeNull();
  });

  it("picks up a buffer's unsaved text when a materialised file is opened", async () => {
    // The file was read from disk for a find-references, and then the user
    // opened the tab, which already had unsaved edits in it. Without this the
    // editor and the server disagree about a file that is now on screen.
    const { client } = fakeClient();
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve("const a = 1") }));
    await ws.requestFile(pathToUri(A));

    ws.openFile(pathToUri(A), "typescript", asView(fakeView("const a = 2")));
    const [update] = ws.syncFiles();
    expect(update.file.doc.toString()).toBe("const a = 2");
  });
});

describe("ToriWorkspace and a mapping that is already running", () => {
  it("adds a newly materialised file to a live mapping", async () => {
    // `findReferences` builds its mapping *before* it asks the workspace for a
    // single file, and the reference panel then maps a position in each one. A
    // mapping only knows the files that existed when it was constructed, and
    // `mapPosition` throws for anything else - inside a promise, so clicking a
    // reference in a file that was not already open would do nothing at all and
    // report nothing.
    const { client, activeMappings } = fakeClient();
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve("const dep = 1") }));
    const live = { mappings: new Map<string, unknown>(), startDocs: new Map<string, Text>() };
    activeMappings.push(live);

    await ws.requestFile(pathToUri(A));

    expect(live.startDocs.get(pathToUri(A))?.toString()).toBe("const dep = 1");
    expect(live.mappings.has(pathToUri(A))).toBe(true);
  });

  it("leaves a file the mapping already snapshotted alone", async () => {
    const { client, activeMappings } = fakeClient();
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve("new") }));
    const original = docOf("as the mapping first saw it");
    const live = {
      mappings: new Map<string, unknown>([[pathToUri(A), "untouched"]]),
      startDocs: new Map([[pathToUri(A), original]]),
    };
    activeMappings.push(live);

    await ws.requestFile(pathToUri(A));

    expect(live.startDocs.get(pathToUri(A))).toBe(original);
    expect(live.mappings.get(pathToUri(A))).toBe("untouched");
  });

  it("does nothing at all when the library stops looking like that", () => {
    // Reaching into another package's internals has to fail soft: no mapping is
    // strictly worse than the panel is today, but a throw here would take
    // opening a file with it.
    const client = { didOpen: () => {}, didClose: () => {}, activeMappings: "not a list" };
    const ws = new ToriWorkspace(client as unknown as LSPClient, deps());
    expect(() => ws.openFile(pathToUri(A), "typescript", asView(fakeView("x")))).not.toThrow();
  });
});

describe("ToriWorkspace headless lifecycle", () => {
  it("holds a bounded number of snapshots and closes what it drops", async () => {
    const { client, opened, closed } = fakeClient();
    const ws = new ToriWorkspace(
      client,
      deps({ diskText: () => Promise.resolve("x"), maxHeadless: 10 }),
    );

    for (let i = 0; i < 200; i++) await ws.requestFile(pathToUri(`/repo/f${i}.ts`));

    expect(opened.length).toBe(200);
    expect(ws.files.length).toBe(10);
    expect(closed.length).toBe(190);
    // Least recently used first: the survivors are the last ten asked for.
    expect(ws.files.map((f) => f.uri)).toEqual(
      Array.from({ length: 10 }, (_, i) => pathToUri(`/repo/f${190 + i}.ts`)),
    );
  });

  it("never evicts the file the editor is showing", async () => {
    const { client, closed } = fakeClient();
    const ws = new ToriWorkspace(
      client,
      deps({ diskText: () => Promise.resolve("x"), maxHeadless: 2 }),
    );
    ws.openFile(pathToUri(A), "typescript", asView(fakeView("shown")));

    for (let i = 0; i < 20; i++) await ws.requestFile(pathToUri(`/repo/f${i}.ts`));

    expect(closed).not.toContain(pathToUri(A));
    expect(ws.getFile(pathToUri(A))?.getView()).toBeTruthy();
  });

  it("defers eviction while a mapping is live, and catches up on release", async () => {
    // A `WorkspaceMapping` snapshots every file at construction and
    // `mapPosition` throws for any URI missing from that snapshot, so evicting
    // mid-operation turns a rename into an exception rather than a smaller one.
    const { client, closed } = fakeClient();
    const ws = new ToriWorkspace(
      client,
      deps({ diskText: () => Promise.resolve("x"), maxHeadless: 2 }),
    );
    await ws.requestFile(pathToUri(A));
    await ws.requestFile(pathToUri(B));

    const release = ws.retainMapping();
    for (let i = 0; i < 5; i++) await ws.requestFile(pathToUri(`/repo/f${i}.ts`));

    expect(closed).toEqual([]);
    expect(ws.getFile(pathToUri(A))).toBeTruthy();

    release();
    expect(closed.length).toBe(5);
    expect(ws.files.length).toBe(2);
  });

  it("defers a deleted file's close while a mapping is live", async () => {
    const { client, closed } = fakeClient();
    let disk: string | null = "x";
    const ws = new ToriWorkspace(client, deps({ diskText: () => Promise.resolve(disk) }));
    await ws.requestFile(pathToUri(A));

    const release = ws.retainMapping();
    disk = null;
    await ws.fileChanged(A);
    expect(closed).toEqual([]);

    release();
    expect(closed).toEqual([pathToUri(A)]);
  });

  it("releases once however often the release is called", async () => {
    const { client, closed } = fakeClient();
    const ws = new ToriWorkspace(
      client,
      deps({ diskText: () => Promise.resolve("x"), maxHeadless: 1 }),
    );
    const outer = ws.retainMapping();
    const inner = ws.retainMapping();
    inner();
    inner();

    await ws.requestFile(pathToUri(A));
    await ws.requestFile(pathToUri(B));
    expect(closed).toEqual([]); // `outer` is still holding

    outer();
    expect(closed).toEqual([pathToUri(A)]);
  });
});

describe("ToriWorkspace displayFile", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the view straight away for a file already on screen", async () => {
    const { client } = fakeClient();
    const opens: string[] = [];
    const ws = new ToriWorkspace(client, deps({ requestOpen: (p) => opens.push(p) }));
    const view = fakeView("shown");
    ws.openFile(pathToUri(A), "typescript", asView(view));

    expect(await ws.displayFile(pathToUri(A))).toBe(asView(view));
    expect(opens).toEqual([]);
  });

  it("asks the app to open the file and resolves once it is", async () => {
    const { client } = fakeClient();
    const opens: string[] = [];
    const ws = new ToriWorkspace(client, deps({ requestOpen: (p) => opens.push(p) }));

    const pending = ws.displayFile(pathToUri(B));
    expect(opens).toEqual([B]);

    // The open is not instant: it reads the file and may await a language
    // chunk import first, which is why this resolves on the report rather than
    // on a guess about how long that takes.
    const view = fakeView("opened");
    ws.openFile(pathToUri(B), "typescript", asView(view));
    expect(await pending).toBe(asView(view));
  });

  it("gives up rather than hanging when the open never arrives", async () => {
    const { client } = fakeClient();
    const ws = new ToriWorkspace(client, deps({ displayTimeoutMs: 1000 }));

    const pending = ws.displayFile(pathToUri(B));
    vi.advanceTimersByTime(1000);
    expect(await pending).toBeNull();
  });

  it("settles its waiters when the client disconnects", async () => {
    const { client } = fakeClient();
    const ws = new ToriWorkspace(client, deps());

    const pending = ws.displayFile(pathToUri(B));
    ws.disconnected();
    expect(await pending).toBeNull();
  });
});
