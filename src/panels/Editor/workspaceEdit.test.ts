import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  applyWorkspaceEdit,
  editsByUri,
  type ApplyDeps,
  type ApplyPolicy,
  type LspPosition,
  type MaterialisedFile,
} from "./workspaceEdit";
import { pathToUri } from "./swayWorkspace";

// The applier is what stands between a server's opinion and someone's files, so
// the cases here are the ones where doing the obvious thing loses something: a
// file nobody opened being skipped, a resource operation half-applied, an
// unsaved buffer written out without the caller getting a say.

const A = "/repo/a.ts";
const B = "/repo/b.ts";
const C = "/repo/c.ts";

function doc(text: string): Text {
  return Text.of(text.split("\n"));
}

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
  return {
    mapPosition: (uri: string, pos: LspPosition) => {
      const d = docs.get(uri);
      if (!d) throw new Error("Cannot map from a file that's not in the workspace");
      return d.line(pos.line + 1).from + pos.character;
    },
    destroy: () => {},
  };
}

/** Proceed no matter what, so a test that is not about policy says nothing
 *  about it. */
const allow: ApplyPolicy = { onDirty: () => Promise.resolve(null) };

function agent(over: Partial<ApplyDeps> & { files?: MaterialisedFile[] } = {}) {
  const files = over.files ?? [file(pathToUri(A), "const before = 1"), file(pathToUri(B), "import { before } from './a'")];
  const byUri = new Map(files.map((f) => [f.uri, f]));
  const written: { path: string; contents: string }[] = [];
  const dispatched: string[] = [];
  const order: string[] = [];

  const deps: ApplyDeps = {
    requestFile: (uri) => {
      order.push(`requestFile:${uri}`);
      return Promise.resolve(byUri.get(uri) ?? null);
    },
    retainMapping: () => () => {},
    makeMapping: () => {
      order.push("makeMapping");
      return mappingOver(files);
    },
    dirtyBuffers: () => [],
    adoptBufferText: () => {},
    writeFiles: (fs) => {
      order.push("writeFiles");
      written.push(...fs);
      return Promise.resolve(fs.map((f) => f.path));
    },
    notifyWritten: () => {},
    dispatch: () => {
      order.push("dispatch");
      dispatched.push("dispatched");
    },
    ...over,
  };
  return { deps, written, dispatched, order };
}

/** The two-file edit the default agent is built for. */
function twoFileEdit() {
  return {
    changes: {
      [pathToUri(A)]: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }],
      [pathToUri(B)]: [{ range: { start: at(0, 9), end: at(0, 15) }, newText: "after" }],
    },
  };
}

describe("applyWorkspaceEdit", () => {
  it("writes a file no tab holds", async () => {
    // The whole reason this module exists: the library's own applier skips any
    // file it cannot already see, which is every file worth reaching.
    const h = agent();

    const out = await applyWorkspaceEdit(twoFileEdit(), h.deps, allow);

    expect(out).toMatchObject({ kind: "applied" });
    expect(h.written.map((w) => w.path).sort()).toEqual([A, B]);
    expect(h.written.find((w) => w.path === A)?.contents).toBe("const after = 1");
    expect(h.written.find((w) => w.path === B)?.contents).toBe("import { after } from './a'");
  });

  it("materialises every file before it builds the mapping", async () => {
    // `WorkspaceMapping` snapshots the open documents in its constructor, so a
    // file materialised afterwards is one it throws for.
    const h = agent();

    await applyWorkspaceEdit(twoFileEdit(), h.deps, allow);

    const mapAt = h.order.indexOf("makeMapping");
    const lastFileAt = h.order.map((o) => o.startsWith("requestFile:")).lastIndexOf(true);
    expect(mapAt).toBeGreaterThan(lastFileAt);
  });

  it("dispatches into the file on screen instead of writing it", async () => {
    const view = {} as EditorView;
    const files = [file(pathToUri(A), "const before = 1", view)];
    const h = agent({ files });

    const out = await applyWorkspaceEdit(
      { changes: { [pathToUri(A)]: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }] } },
      h.deps,
      allow,
    );

    expect(out).toMatchObject({ kind: "applied", dispatched: [A] });
    expect(h.written).toEqual([]);
  });

  it("says nothing to do when the edit names no file", async () => {
    const h = agent();
    expect(await applyWorkspaceEdit({}, h.deps, allow)).toEqual({ kind: "empty" });
    expect(await applyWorkspaceEdit(null, h.deps, allow)).toEqual({ kind: "empty" });
  });
});

describe("applyWorkspaceEdit refuses resource operations", () => {
  it("names both the file and the operation, so the refusal does not read as a bug", async () => {
    const h = agent();

    const out = await applyWorkspaceEdit(
      { documentChanges: [{ kind: "create", uri: pathToUri(C) }] },
      h.deps,
      allow,
    );

    expect(out).toMatchObject({ kind: "aborted" });
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain("c.ts");
    expect(reason).toContain("create");
  });

  it("names the file a rename would move, not the one it would become", async () => {
    const h = agent();

    const out = await applyWorkspaceEdit(
      { documentChanges: [{ kind: "rename", oldUri: pathToUri(A), newUri: pathToUri(C) }] },
      h.deps,
      allow,
    );

    expect((out as { reason: string }).reason).toContain("a.ts");
    expect((out as { reason: string }).reason).toContain("rename");
  });

  it("applies no text edit from an edit that also carries one", async () => {
    // The half-applied case is the dangerous one: the text edits assume the
    // file the operation was going to create, so landing them alone leaves the
    // tree describing something that never happened.
    const h = agent();

    const out = await applyWorkspaceEdit(
      {
        documentChanges: [
          { textDocument: { uri: pathToUri(A) }, edits: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }] },
          { kind: "create", uri: pathToUri(C) },
        ],
      },
      h.deps,
      allow,
    );

    expect(out).toMatchObject({ kind: "aborted" });
    expect(h.written, "nothing was written").toEqual([]);
    expect(h.dispatched, "nothing was dispatched").toEqual([]);
    expect(h.order, "no file was even opened").toEqual([]);
  });

  it("still applies an ordinary documentChanges edit, so the guard is not too wide", async () => {
    const h = agent();

    const out = await applyWorkspaceEdit(
      {
        documentChanges: [
          { textDocument: { uri: pathToUri(A) }, edits: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }] },
        ],
      },
      h.deps,
      allow,
    );

    expect(out).toMatchObject({ kind: "applied" });
    expect(h.written.find((w) => w.path === A)?.contents).toBe("const after = 1");
  });
});

describe("editsByUri", () => {
  it("skips a resource operation rather than reading it as a file with no edits", () => {
    expect(
      editsByUri({
        documentChanges: [
          { kind: "delete", uri: pathToUri(C) },
          { textDocument: { uri: pathToUri(A) }, edits: [{ range: { start: at(0, 0), end: at(0, 1) }, newText: "x" }] },
        ],
      }),
    ).toEqual([{ uri: pathToUri(A), edits: [{ range: { start: at(0, 0), end: at(0, 1) }, newText: "x" }] }]);
  });
});

describe("the dirty-buffer policy", () => {
  it("asks about background buffers only, never the file on screen", async () => {
    const view = {} as EditorView;
    const files = [file(pathToUri(A), "const before = 1", view), file(pathToUri(B), "import { before } from './a'")];
    const asked: string[][] = [];
    const h = agent({ files, dirtyBuffers: (paths) => paths });

    await applyWorkspaceEdit(twoFileEdit(), h.deps, {
      onDirty: (dirty) => {
        asked.push(dirty);
        return Promise.resolve(null);
      },
    });

    expect(asked).toEqual([[B]]);
  });

  it("aborts with the policy's own reason, writing nothing", async () => {
    // What a server-initiated edit does instead of opening a modal.
    const h = agent({ dirtyBuffers: (paths) => paths });

    const out = await applyWorkspaceEdit(twoFileEdit(), h.deps, {
      onDirty: () => Promise.resolve("b.ts has unsaved changes, so nothing was changed."),
    });

    expect(out).toMatchObject({ kind: "aborted", reason: "b.ts has unsaved changes, so nothing was changed." });
    expect(h.written).toEqual([]);
  });

  it("runs precheck before it asks anyone anything", async () => {
    const h = agent({ dirtyBuffers: (paths) => paths });
    let asked = 0;

    const out = await applyWorkspaceEdit(twoFileEdit(), h.deps, {
      precheck: () => Promise.resolve("no undo path here"),
      onDirty: () => {
        asked += 1;
        return Promise.resolve(null);
      },
    });

    expect(out).toMatchObject({ kind: "aborted", reason: "no undo path here" });
    expect(asked, "nobody was asked to approve something already refused").toBe(0);
  });
});
