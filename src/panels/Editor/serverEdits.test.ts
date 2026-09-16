import { describe, it, expect, vi, afterEach } from "vitest";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { answerApplyEdit, APPLY_EDIT_TIMEOUT_MS } from "./serverEdits";
import type { ApplyDeps, LspPosition, MaterialisedFile } from "./workspaceEdit";
import { pathToUri } from "./toriWorkspace";

// A server sends `workspace/applyEdit` in the middle of a command and blocks on
// the answer. Every case here is about the two ways that goes wrong: an answer
// that never comes, and an answer bought by saving somebody's unsaved work
// without asking - because asking is the thing this path cannot do.

const A = "/repo/a.ts";
const B = "/repo/b.ts";

function file(uri: string, text: string, view: EditorView | null = null): MaterialisedFile {
  return { uri, doc: Text.of(text.split("\n")), getView: () => view };
}

function at(line: number, character: number): LspPosition {
  return { line, character };
}

function agent(over: Partial<ApplyDeps> & { files?: MaterialisedFile[] } = {}) {
  const files = over.files ?? [file(pathToUri(A), "const before = 1"), file(pathToUri(B), "import { before } from './a'")];
  const byUri = new Map(files.map((f) => [f.uri, f]));
  const written: { path: string; contents: string }[] = [];
  const notices: string[] = [];

  const deps: ApplyDeps = {
    requestFile: (uri) => Promise.resolve(byUri.get(uri) ?? null),
    retainMapping: () => () => {},
    makeMapping: () => ({
      mapPosition: (uri: string, pos: LspPosition) => {
        const d = byUri.get(uri)!.doc;
        return d.line(pos.line + 1).from + pos.character;
      },
      destroy: () => {},
    }),
    dirtyBuffers: () => [],
    adoptBufferText: () => {},
    writeFiles: (fs) => {
      written.push(...fs);
      return Promise.resolve(fs.map((f) => f.path));
    },
    notifyWritten: () => {},
    dispatch: () => {},
    ...over,
  };
  return { deps, written, notices, notify: (m: string) => notices.push(m) };
}

const params = () => ({
  label: "Organize imports",
  edit: {
    changes: {
      [pathToUri(A)]: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }],
      [pathToUri(B)]: [{ range: { start: at(0, 9), end: at(0, 15) }, newText: "after" }],
    },
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("answerApplyEdit", () => {
  it("applies an edit over clean files and says so", async () => {
    const h = agent();

    const res = await answerApplyEdit(params(), h.deps, h.notify);

    expect(res).toEqual({ applied: true });
    expect(h.written.map((w) => w.path).sort()).toEqual([A, B]);
    expect(h.notices, "a success needs no notice").toEqual([]);
  });

  it("refuses rather than saving a dirty background buffer, and never asks", async () => {
    // The interactive path opens a modal here. On this path the server is
    // blocked on the answer, so a modal would park it until its own timeout.
    const h = agent({ dirtyBuffers: (paths) => paths });

    const res = await answerApplyEdit(params(), h.deps, h.notify);

    expect(res.applied).toBe(false);
    expect(res.failureReason).toContain("unsaved changes");
    expect(h.written, "nothing was written").toEqual([]);
    expect(h.notices, "the reason was surfaced, since the server's answer is invisible").toEqual([
      res.failureReason,
    ]);
  });

  it("answers a resource operation with a reason instead of applying half of it", async () => {
    const h = agent();

    const res = await answerApplyEdit(
      { edit: { documentChanges: [{ kind: "create", uri: pathToUri("/repo/new.ts") }] } },
      h.deps,
      h.notify,
    );

    expect(res.applied).toBe(false);
    expect(res.failureReason).toContain("new.ts");
    expect(h.written).toEqual([]);
  });

  it("treats an edit with nothing in it as applied, not as a failure", async () => {
    const h = agent();
    expect(await answerApplyEdit({ edit: {} }, h.deps, h.notify)).toEqual({ applied: true });
    expect(h.notices).toEqual([]);
  });

  it("answers even when no session can serve the edit", async () => {
    // A project switch while the server was mid-command. An unanswered request
    // leaves it parked on its own timeout.
    const h = agent();

    const res = await answerApplyEdit(params(), null, h.notify);

    expect(res.applied).toBe(false);
    expect(res.failureReason).toBeTruthy();
    expect(h.notices).toHaveLength(1);
  });

  it("turns a thrown apply into an answer rather than a rejection", async () => {
    const h = agent({
      requestFile: () => Promise.reject(new Error("workspace is gone")),
    });

    const res = await answerApplyEdit(params(), h.deps, h.notify);

    expect(res.applied).toBe(false);
    expect(res.failureReason).toContain("workspace is gone");
  });
});

describe("answerApplyEdit does not let a wedged apply hold the server open", () => {
  it("answers within two seconds, on a fake clock", async () => {
    vi.useFakeTimers();
    // Never settles, which is what a wedged workspace looks like from here.
    const h = agent({ requestFile: () => new Promise<MaterialisedFile | null>(() => {}) });

    const pending = answerApplyEdit(params(), h.deps, h.notify);
    await vi.advanceTimersByTimeAsync(APPLY_EDIT_TIMEOUT_MS);
    const res = await pending;

    expect(res.applied).toBe(false);
    expect(res.failureReason).toContain("too long");
    expect(h.written).toEqual([]);
  });

  it("waits the full two seconds and no less, so a merely slow apply still lands", async () => {
    vi.useFakeTimers();
    let release: (f: MaterialisedFile | null) => void = () => {};
    const files = [file(pathToUri(A), "const before = 1")];
    const h = agent({
      files,
      requestFile: () => new Promise<MaterialisedFile | null>((r) => (release = r)),
    });

    const pending = answerApplyEdit(
      { edit: { changes: { [pathToUri(A)]: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }] } } },
      h.deps,
      h.notify,
    );
    await vi.advanceTimersByTimeAsync(APPLY_EDIT_TIMEOUT_MS - 1);
    release(files[0]);
    const res = await pending;

    expect(res).toEqual({ applied: true });
  });

  it("writes nothing once it has already answered, however late the apply finishes", async () => {
    // The dangerous half of a deadline. A promise cannot be cancelled, so an
    // apply that was merely slow rather than wedged would otherwise finish at
    // 2.1s and write files behind the `applied: false` already on the wire -
    // leaving the server certain nothing changed while the tree disagrees.
    vi.useFakeTimers();
    let release: (f: MaterialisedFile | null) => void = () => {};
    const files = [file(pathToUri(A), "const before = 1")];
    const h = agent({ files, requestFile: () => new Promise<MaterialisedFile | null>((r) => (release = r)) });

    const pending = answerApplyEdit(
      { edit: { changes: { [pathToUri(A)]: [{ range: { start: at(0, 6), end: at(0, 12) }, newText: "after" }] } } },
      h.deps,
      h.notify,
    );
    await vi.advanceTimersByTimeAsync(APPLY_EDIT_TIMEOUT_MS);
    const res = await pending;
    expect(res.applied, "answered already").toBe(false);

    // Only now does the file arrive, so the abandoned apply runs on to its write.
    release(files[0]);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.written, "it stopped itself at the last gate before writing").toEqual([]);
  });

  it("bounds every server the same, since this measures a person's patience", () => {
    // Deliberately not the session's `request_timeout_ms`, which is 20s for
    // TypeScript and 90s for rust-analyzer and measures the opposite direction.
    expect(APPLY_EDIT_TIMEOUT_MS).toBe(2000);
    // The signature carries no server, so there is nowhere for a per-server
    // value to enter.
    expect(answerApplyEdit.length).toBeLessThanOrEqual(4);
  });
});
