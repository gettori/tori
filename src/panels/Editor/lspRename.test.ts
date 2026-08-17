import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  describeRename,
  editsByUri,
  renameAcross,
  type LspPosition,
  type MaterialisedFile,
  type RenameDeps,
} from "./lspRename";
import { pathToUri } from "./swayWorkspace";

// A cross-file rename is the most destructive thing the editor does on its own:
// it rewrites files the user is not looking at, some of which hold unsaved
// work. The cases that matter here are the ones where doing the obvious thing
// loses something - a file that was skipped without a word, a write that landed
// halfway, an unsaved buffer saved out from under someone.

const A = "/repo/a.ts";
const B = "/repo/b.ts";
const C = "/repo/c.ts";

function doc(text: string): Text {
  return Text.of(text.split("\n"));
}

/** LSP positions for the Nth occurrence of `word` on the given line. */
function at(line: number, character: number): LspPosition {
  return { line, character };
}

function file(uri: string, text: string, view: EditorView | null = null): MaterialisedFile {
  return { uri, doc: doc(text), getView: () => view };
}

/** A mapping that resolves positions against the documents it was given, and
 *  throws for anything it never saw - exactly as `WorkspaceMapping` does. */
function mappingOver(files: MaterialisedFile[]) {
  const docs = new Map(files.map((f) => [f.uri, f.doc]));
  let destroyed = 0;
  return {
    destroyed: () => destroyed,
    mapping: {
      mapPosition: (uri: string, pos: LspPosition) => {
        const d = docs.get(uri);
        if (!d) throw new Error("Cannot map from a file that's not in the workspace");
        return d.line(pos.line + 1).from + pos.character;
      },
      destroy: () => {
        destroyed += 1;
      },
    },
  };
}

type Agent = {
  deps: RenameDeps;
  written: { path: string; contents: string }[];
  dispatched: string[];
  adopted: { path: string; text: string }[];
  confirms: string[];
  order: string[];
  backstops: string[];
  notified: string[][];
  retained: () => number;
  released: () => number;
};

function agent(over: Partial<RenameDeps> & { files?: MaterialisedFile[] } = {}): Agent {
  const files = over.files ?? [file(pathToUri(A), "const before = 1"), file(pathToUri(B), "import { before } from './a'")];
  const byUri = new Map(files.map((f) => [f.uri, f]));
  const written: { path: string; contents: string }[] = [];
  const dispatched: string[] = [];
  const adopted: { path: string; text: string }[] = [];
  const confirms: string[] = [];
  const backstops: string[] = [];
  const order: string[] = [];
  const notified: string[][] = [];
  let retained = 0;
  let released = 0;
  const m = mappingOver(files);

  const deps: RenameDeps = {
    requestRename: () =>
      Promise.resolve({
        changes: {
          [pathToUri(A)]: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }],
          [pathToUri(B)]: [{ range: { start: at(0, 9), end: at(0, 15) }, newText: "after" }],
        },
      }),
    requestFile: (uri) => {
      order.push(`requestFile:${uri}`);
      return Promise.resolve(byUri.get(uri) ?? null);
    },
    retainMapping: () => {
      retained += 1;
      return () => {
        released += 1;
      };
    },
    makeMapping: () => {
      order.push("makeMapping");
      return m.mapping;
    },
    dirtyBuffers: () => [],
    adoptBufferText: (path, text) => adopted.push({ path, text }),
    writeFiles: (fs) => {
      order.push("writeFiles");
      written.push(...fs);
      return Promise.resolve(fs.map((f) => f.path));
    },
    notifyWritten: (paths) => {
      order.push("notifyWritten");
      notified.push(paths);
    },
    backstopAvailable: () => Promise.resolve(true),
    takeBackstop: (label) => {
      order.push("takeBackstop");
      backstops.push(label);
      return Promise.resolve(1234);
    },
    confirm: (opts) => {
      confirms.push(opts.message);
      return Promise.resolve(true);
    },
    dispatch: (_view) => {
      order.push("dispatch");
      dispatched.push("dispatched");
    },
    ...over,
  };
  return {
    deps,
    written,
    dispatched,
    adopted,
    confirms,
    order,
    backstops,
    notified,
    retained: () => retained,
    released: () => released,
  };
}

describe("editsByUri", () => {
  it("reads the `changes` map", () => {
    const targets = editsByUri({
      changes: { "file:///a.ts": [{ range: { start: at(0, 0), end: at(0, 1) }, newText: "x" }] },
    });
    expect(targets).toEqual([
      { uri: "file:///a.ts", edits: [{ range: { start: at(0, 0), end: at(0, 1) }, newText: "x" }] },
    ]);
  });

  it("reads `documentChanges` too, which some servers send regardless", () => {
    const targets = editsByUri({
      documentChanges: [
        { textDocument: { uri: "file:///a.ts" }, edits: [{ range: { start: at(1, 2), end: at(1, 3) }, newText: "y" }] },
      ],
    });
    expect(targets.map((t) => t.uri)).toEqual(["file:///a.ts"]);
  });

  it("does not apply a server's edits twice when it sends both shapes", () => {
    const edit = { range: { start: at(0, 0), end: at(0, 1) }, newText: "x" };
    const targets = editsByUri({
      changes: { "file:///a.ts": [edit] },
      documentChanges: [{ textDocument: { uri: "file:///a.ts" }, edits: [edit] }],
    });
    expect(targets[0].edits).toHaveLength(1);
  });

  it("drops a file with nothing to change, so it is neither opened nor written", () => {
    expect(editsByUri({ changes: { "file:///a.ts": [] } })).toEqual([]);
    expect(editsByUri(null)).toEqual([]);
  });
});

describe("renameAcross", () => {
  it("writes every file, including ones nobody opened", async () => {
    // The whole point. The library's `doRename` skips any file the workspace
    // does not already hold, and it holds only files with a live view, so this
    // set produces zero writes there.
    const h = agent();
    const out = await renameAcross(h.deps, "after");

    expect(out).toMatchObject({ kind: "applied" });
    expect(h.written.map((w) => w.path).sort()).toEqual([A, B]);
    expect(h.written.find((w) => w.path === A)?.contents).toBe("const after = 1");
    expect(h.written.find((w) => w.path === B)?.contents).toBe("import { after } from './a'");
  });

  it("materialises every file before it builds the mapping", async () => {
    // The ordering that makes the rest possible. `WorkspaceMapping` snapshots
    // the open files in its constructor and `mapPosition` throws for anything
    // absent, so a mapping taken first cannot answer for the files this rename
    // is about.
    const h = agent();
    await renameAcross(h.deps, "after");

    const mappingAt = h.order.indexOf("makeMapping");
    const lastRequest = h.order.map((s) => s.startsWith("requestFile:")).lastIndexOf(true);
    expect(mappingAt).toBeGreaterThan(lastRequest);
  });

  it("dispatches into the file on screen instead of writing it", async () => {
    // Its undo history is the one the user can actually reach, so the rename
    // joins it rather than going around it.
    const view = {} as EditorView;
    const h = agent({
      files: [file(pathToUri(A), "const before = 1", view), file(pathToUri(B), "import { before } from './a'")],
    });
    const out = await renameAcross(h.deps, "after");

    expect(out).toMatchObject({ kind: "applied", dispatched: [A] });
    expect(h.written.map((w) => w.path)).toEqual([B]);
  });

  it("holds the workspace open, and lets go even when the rename fails", async () => {
    const ok = agent();
    await renameAcross(ok.deps, "after");
    expect(ok.retained()).toBe(1);
    expect(ok.released()).toBe(1);

    const failing = agent({ writeFiles: () => Promise.reject(new Error("disk full.")) });
    const out = await renameAcross(failing.deps, "after");
    expect(out).toMatchObject({ kind: "aborted" });
    expect(failing.retained()).toBe(1);
    expect(failing.released()).toBe(1);
  });

  it("tells the language workspace about every file it wrote", async () => {
    // Otherwise the server keeps answering from the pre-rename text. The fs
    // watcher would eventually notice, but it is debounced and it skips whole
    // directories (`node_modules`, `dist`, `target`), so a target inside one
    // would never be corrected at all.
    const h = agent();
    await renameAcross(h.deps, "after");

    expect(h.notified).toEqual([[A, B]]);
    // After the buffers took the new text, so re-reading a file finds the
    // rename rather than the copy the tab still held a moment ago.
    expect(h.order.indexOf("notifyWritten")).toBeGreaterThan(h.order.indexOf("writeFiles"));
  });

  it("tells it nothing when the write never happened", async () => {
    const h = agent({ writeFiles: () => Promise.reject(new Error("disk full.")) });
    await renameAcross(h.deps, "after");
    expect(h.notified).toEqual([]);
  });

  it("takes a backstop before the first write", async () => {
    const h = agent();
    await renameAcross(h.deps, "after");

    expect(h.backstops).toEqual(['Rename to "after" in 2 files']);
    expect(h.order.indexOf("takeBackstop")).toBeLessThan(h.order.indexOf("writeFiles"));
  });

  it("does not take a backstop for a rename inside one file", async () => {
    const h = agent({ files: [file(pathToUri(A), "const before = 1")] });
    h.deps.requestRename = () =>
      Promise.resolve({ changes: { [pathToUri(A)]: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }] } });

    const out = await renameAcross(h.deps, "after");
    expect(out).toMatchObject({ kind: "applied", backstopTs: null });
    expect(h.backstops).toEqual([]);
  });
});

describe("renameAcross refuses rather than half-applying", () => {
  it("stops when a target file cannot be read, before writing anything", async () => {
    const h = agent({ requestFile: (uri) => Promise.resolve(uri.endsWith("b.ts") ? null : file(uri, "x")) });
    const out = await renameAcross(h.deps, "after");

    expect(out).toMatchObject({ kind: "aborted" });
    expect((out as { reason: string }).reason).toContain("b.ts");
    expect(h.written).toEqual([]);
    expect(h.backstops).toEqual([]);
  });

  it("stops when the write is refused, and dispatches nothing", async () => {
    // The batched write is all-or-nothing, so an aborted one leaves the tree
    // alone. Dispatching anyway would leave the editor showing a rename that
    // exists nowhere else.
    const view = {} as EditorView;
    const h = agent({
      files: [file(pathToUri(A), "const before = 1", view), file(pathToUri(B), "import { before } from './a'")],
      writeFiles: () => Promise.reject(new Error("b.ts is read-only, so nothing was changed.")),
    });
    const out = await renameAcross(h.deps, "after");

    expect(out).toMatchObject({ kind: "aborted" });
    expect((out as { reason: string }).reason).toContain("read-only");
    expect(h.dispatched).toEqual([]);
    expect(h.adopted).toEqual([]);
  });

  it("stops when a position cannot be placed rather than writing a mangled file", async () => {
    const h = agent();
    h.deps.makeMapping = () => ({
      mapPosition: () => {
        throw new Error("Cannot map from a file that's not in the workspace");
      },
      destroy: () => {},
    });
    const out = await renameAcross(h.deps, "after");

    expect(out).toMatchObject({ kind: "aborted" });
    expect(h.written).toEqual([]);
  });

  it("refuses a multi-file rename in a folder with no undo path", async () => {
    // Sway opens plain folders. Rewriting several files there with nothing to
    // restore from is not something to do quietly.
    const h = agent({ backstopAvailable: () => Promise.resolve(false) });
    const out = await renameAcross(h.deps, "after");

    expect(out).toMatchObject({ kind: "aborted" });
    expect((out as { reason: string }).reason).toContain("not a git repository");
    expect(h.written).toEqual([]);
  });

  it("still renames inside a single file with no undo path", async () => {
    const h = agent({
      files: [file(pathToUri(A), "const before = 1")],
      backstopAvailable: () => Promise.resolve(false),
    });
    h.deps.requestRename = () =>
      Promise.resolve({ changes: { [pathToUri(A)]: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }] } });

    const out = await renameAcross(h.deps, "after");
    expect(out).toMatchObject({ kind: "applied" });
    expect(h.written.map((w) => w.path)).toEqual([A]);
  });

  it("says nothing changed when the server has nothing to rename", async () => {
    const h = agent({ requestRename: () => Promise.resolve({ changes: {} }) });
    expect(await renameAcross(h.deps, "after")).toEqual({ kind: "empty" });
    expect(h.written).toEqual([]);
  });

  it("reports a failed rename request instead of throwing", async () => {
    const h = agent({ requestRename: () => Promise.reject(new Error("timed out")) });
    const out = await renameAcross(h.deps, "after");
    expect(out).toMatchObject({ kind: "aborted" });
    expect((out as { reason: string }).reason).toContain("timed out");
  });
});

describe("renameAcross and unsaved background edits", () => {
  it("asks before saving a background tab's unsaved work", async () => {
    // A background buffer is viewless, so the only way a rename reaches it is
    // by writing its file - which saves whatever else the user had typed there.
    // Nothing is lost either way; being asked is the point.
    const h = agent({ dirtyBuffers: (paths) => paths.filter((p) => p === B) });
    const out = await renameAcross(h.deps, "after");

    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toContain("b.ts");
    expect(h.confirms[0]).toContain("unsaved changes");
    expect(out).toMatchObject({ kind: "applied" });
  });

  it("writes nothing when that answer is no", async () => {
    const h = agent({
      dirtyBuffers: (paths) => paths.filter((p) => p === B),
      confirm: () => Promise.resolve(false),
    });
    const out = await renameAcross(h.deps, "after");

    expect(out).toMatchObject({ kind: "aborted" });
    expect(h.written).toEqual([]);
    expect(h.backstops).toEqual([]);
  });

  it("does not ask about the file on screen, whose edits stay unsaved", async () => {
    // It is dispatched into, not written, so its unsaved state is exactly as it
    // was. Asking would be a question about nothing.
    const view = {} as EditorView;
    const h = agent({
      files: [file(pathToUri(A), "const before = 1", view), file(pathToUri(B), "import { before } from './a'")],
      dirtyBuffers: (paths) => paths,
    });
    const out = await renameAcross(h.deps, "after");

    expect(h.confirms[0]).not.toContain("a.ts");
    expect(out).toMatchObject({ kind: "applied" });
  });

  it("leaves an open background buffer agreeing with the file it just wrote", async () => {
    // Otherwise the tab still holds the pre-rename text, reads as dirty against
    // a file that moved, and a later save quietly puts the old name back.
    const h = agent();
    await renameAcross(h.deps, "after");

    expect(h.adopted).toEqual([
      { path: A, text: "const after = 1" },
      { path: B, text: "import { after } from './a'" },
    ]);
  });
});

describe("describeRename", () => {
  it("says nothing about a rename the user can see happen", async () => {
    expect(describeRename({ kind: "applied", written: [A], dispatched: [], backstopTs: null })).toBeNull();
  });

  it("says plainly that the undo covers only what was saved", () => {
    // The file on screen took the rename as an editor change, so a working-tree
    // restore does not touch it. Claiming a blanket undo would be a lie the
    // user only finds out about after using it.
    const said = describeRename({
      kind: "applied",
      written: [B, C, "/repo/d.ts"],
      dispatched: [A],
      backstopTs: 99,
    });
    expect(said?.kind).toBe("info");
    expect(said?.message).toContain("4 files");
    expect(said?.message).toContain("the 3 saved to disk");
    expect(said?.message).toContain("its own undo history");
  });

  it("promises a full undo when nothing was left in the editor", () => {
    const said = describeRename({ kind: "applied", written: [A, B], dispatched: [], backstopTs: 99 });
    expect(said?.message).toContain("Undo restores all 2.");
    expect(said?.message).not.toContain("undo history");
  });

  it("does not offer to restore zero files", () => {
    // Unreachable with one `EditorView`, and exactly what split editors would
    // produce. "Undo restores the 0 saved to disk" is worse than saying nothing.
    const said = describeRename({ kind: "applied", written: [], dispatched: [A, B], backstopTs: null });
    expect(said?.message).not.toContain("0");
    expect(said?.message).toContain("each file's own history");
  });

  it("carries a refusal through as an error", () => {
    const said = describeRename({ kind: "aborted", reason: "b.ts is read-only, so nothing was changed." });
    expect(said).toEqual({ message: "b.ts is read-only, so nothing was changed.", kind: "error" });
  });

  it("says so when there was nothing to rename", () => {
    expect(describeRename({ kind: "empty" })).toEqual({ message: "Nothing to rename here.", kind: "info" });
  });
});

describe("renameAcross across many files", () => {
  it("writes every one of a large set through a single batched call", async () => {
    // `isSelfWrite`'s TTL is sized for one save; N separate writes would race
    // it and the tail would read as somebody else's edits.
    const many = Array.from({ length: 150 }, (_, i) => file(pathToUri(`/repo/f${i}.ts`), "const before = 1"));
    let calls = 0;
    const h = agent({
      files: many,
      writeFiles: (fs) => {
        calls += 1;
        return Promise.resolve(fs.map((f) => f.path));
      },
    });
    h.deps.requestRename = () =>
      Promise.resolve({
        changes: Object.fromEntries(
          many.map((f) => [f.uri, [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }]]),
        ),
      });

    const out = await renameAcross(h.deps, "after");
    expect(out).toMatchObject({ kind: "applied" });
    expect((out as { written: string[] }).written).toHaveLength(150);
    expect(calls).toBe(1);
  });
});
