import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Text } from "@codemirror/state";

// The policy half of running a code action: who gets asked before somebody's
// unsaved work is written, and what has to exist before a change nobody can
// undo is made. Deliberately the same shape as `renameAcross`'s, because a code
// action the user picked can rewrite files nobody is looking at and CodeMirror's
// undo cannot reach a file it never had open.
//
// The applier itself is real here. What is faked is only the world around it:
// the workspace, the write, and the two questions that reach the app.

const A = "/repo/a.ts";
const B = "/repo/b.ts";
const uri = (p: string) => `file://${p}`;

let docs = new Map<string, { text: string; view: object | null }>();
let written: { path: string; contents: string }[] = [];
let dirty: string[] = [];
let invoked: { cmd: string; args: Record<string, unknown> }[] = [];
let backstopOk = true;
let backstopThrows = false;
let commandRuns: { command: string; args?: unknown[] }[] = [];
let executeAnswer: unknown = null;
let executeProvider = true;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd === "backstop_available") return Promise.resolve(backstopOk);
    if (cmd === "backstop_take") {
      return backstopThrows ? Promise.reject(new Error("no repo")) : Promise.resolve({ ts: 42 });
    }
    return Promise.resolve(null);
  },
}));

// One fake client, shared by the plugin the view "has" and by the applier.
const client = {
  workspace: {
    requestFile: (u: string) => {
      const d = docs.get(u);
      return Promise.resolve(d ? { uri: u, doc: Text.of(d.text.split("\n")), getView: () => d.view } : null);
    },
    retainMapping: () => () => {},
  },
  // Positions are line/character over the same docs the workspace hands out.
  workspaceMapping: () => ({
    mapPosition: (u: string, pos: { line: number; character: number }) =>
      Text.of(docs.get(u)!.text.split("\n")).line(pos.line + 1).from + pos.character,
    destroy: () => {},
  }),
};

// Partial: `toriWorkspace` extends the library's `Workspace` further down the
// import graph, so replacing the whole module would leave it with no base class.
vi.mock("@codemirror/lsp-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LSPPlugin: { get: () => plugin },
}));

vi.mock("./batchWrite", () => ({
  writeFilesSuppressingEcho: (files: { path: string; contents: string }[]) => {
    written.push(...files);
    return Promise.resolve(files.map((f) => f.path));
  },
}));

vi.mock("./liveBuffers", () => ({
  adoptBufferText: () => {},
  dirtyBuffers: (paths: string[]) => paths.filter((p) => dirty.includes(p)),
}));

vi.mock("./lspClient", () => ({
  lspTargetsFor: () => [{ supports: () => executeProvider }],
  executeServerCommand: (_t: unknown, command: string, args?: unknown[]) => {
    commandRuns.push({ command, args });
    return Promise.resolve(executeAnswer);
  },
  notifyLspFileChanged: () => {},
}));

let plugin: unknown = { client };

const { applyCodeAction, codeActionRunner } = await import("./codeActionCommand");

const view = { dispatch: () => {} } as never;

function io(answer = true) {
  const asked: { message: string }[] = [];
  const said: { message: string; kind: string }[] = [];
  return {
    asked,
    said,
    io: {
      projectRoot: () => "/repo",
      confirm: (opts: { title: string; message: string; confirmLabel: string }) => {
        asked.push(opts);
        return Promise.resolve(answer);
      },
      notify: (message: string, kind: "error" | "info") => said.push({ message, kind }),
    },
  };
}

/** An edit renaming `before` to `after` in each of the named files. */
const editOver = (paths: string[]) => ({
  changes: Object.fromEntries(
    paths.map((p) => [uri(p), [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } }, newText: "after" }]]),
  ),
});

beforeEach(() => {
  docs = new Map([
    [uri(A), { text: "const before = 1", view: null }],
    [uri(B), { text: "const before = 2", view: null }],
  ]);
  written = [];
  dirty = [];
  invoked = [];
  backstopOk = true;
  backstopThrows = false;
  commandRuns = [];
  executeAnswer = null;
  executeProvider = true;
  plugin = { client };
});

afterEach(() => vi.restoreAllMocks());

describe("applying a code action's edit", () => {
  it("applies a single-file edit without asking anything", async () => {
    const h = io();

    const out = await applyCodeAction(view, A, { title: "Add import", edit: editOver([A]) }, h.io);

    expect(out).toEqual({ kind: "done" });
    expect(written.map((w) => w.path)).toEqual([A]);
    expect(h.asked, "nobody was asked about a change they can see").toEqual([]);
    expect(h.said, "and a change on screen speaks for itself").toEqual([]);
  });

  it("takes no snapshot for a single file, since undo already reaches it", async () => {
    await applyCodeAction(view, A, { title: "Add import", edit: editOver([A]) }, io().io);
    expect(invoked.map((i) => i.cmd)).not.toContain("backstop_take");
  });

  it("snapshots before writing more than one file", async () => {
    // The only way back: CodeMirror's undo cannot reach a file it never had
    // open, and a multi-file rewrite touches exactly those.
    await applyCodeAction(view, A, { title: "Organize imports", edit: editOver([A, B]) }, io().io);

    const take = invoked.find((i) => i.cmd === "backstop_take");
    expect(take?.args.repoPath).toBe("/repo");
    expect(take?.args.label, "named after what it can undo").toBe("Organize imports");
    expect(written).toHaveLength(2);
  });

  it("refuses a multi-file change in a folder it cannot snapshot", async () => {
    // Checked before anyone is asked anything, so nobody approves something
    // that was going to be refused anyway.
    backstopOk = false;
    const h = io();

    const out = await applyCodeAction(view, A, { title: "Fix all", edit: editOver([A, B]) }, h.io);

    expect(out.kind).toBe("refused");
    expect((out as { reason: string }).reason).toContain("not a git repository");
    expect(written, "nothing was written").toEqual([]);
    expect(h.asked, "and nobody was asked to approve it").toEqual([]);
    expect(h.said[0].kind).toBe("error");
  });

  it("refuses rather than half-applying when the snapshot itself fails", async () => {
    backstopThrows = true;

    const out = await applyCodeAction(view, A, { title: "Fix all", edit: editOver([A, B]) }, io().io);

    expect(out.kind).toBe("refused");
    expect(written).toEqual([]);
  });

  it("asks before writing a background buffer somebody has unsaved work in", async () => {
    dirty = [B];
    const h = io(true);

    const out = await applyCodeAction(view, A, { title: "Fix all", edit: editOver([A, B]) }, h.io);

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].message).toContain("Fix all");
    expect(out).toEqual({ kind: "done" });
    expect(written).toHaveLength(2);
  });

  it("changes nothing when that question is answered no", async () => {
    dirty = [B];
    const h = io(false);

    const out = await applyCodeAction(view, A, { title: "Fix all", edit: editOver([A, B]) }, h.io);

    expect(out.kind).toBe("refused");
    expect(written, "their unsaved work is untouched").toEqual([]);
  });

  it("says what a multi-file change did, and how much of it undo covers", async () => {
    // Both halves are surprising: files nobody was looking at just changed, and
    // undo does not reach all of them the same way.
    const h = io();

    await applyCodeAction(view, A, { title: "Organize imports", edit: editOver([A, B]) }, h.io);

    expect(h.said).toHaveLength(1);
    expect(h.said[0].kind).toBe("info");
    expect(h.said[0].message).toContain("changed 2 files");
    expect(h.said[0].message).toContain("Undo restores all 2");
  });

  it("refuses a resource operation by name, taking the whole edit with it", async () => {
    const h = io();

    const out = await applyCodeAction(
      view,
      A,
      { title: "Move to new file", edit: { documentChanges: [{ kind: "create", uri: uri("/repo/new.ts") }] } },
      h.io,
    );

    expect(out.kind).toBe("refused");
    expect((out as { reason: string }).reason).toContain("new.ts");
    expect(written).toEqual([]);
  });
});

describe("running a code action's command", () => {
  it("sends it to the server, arguments and all", async () => {
    const out = await applyCodeAction(
      view,
      A,
      { title: "Organize imports", command: { command: "_typescript.organizeImports", arguments: [A] } },
      io().io,
    );

    expect(out).toEqual({ kind: "done" });
    expect(commandRuns).toEqual([{ command: "_typescript.organizeImports", args: [A] }]);
  });

  it("reports a server that runs no commands, rather than reading it as success", async () => {
    // `executeServerCommand` answers null both for "no provider" and for "the
    // command returned nothing", and only the first is a failure.
    executeProvider = false;
    const h = io();

    const out = await applyCodeAction(view, A, { title: "Organize imports", command: { command: "x" } }, h.io);

    expect(out.kind).toBe("refused");
    expect(h.said[0].kind).toBe("error");
  });

  it("does not run the command when the edit before it was refused", async () => {
    // The command is the server's follow-up to changes that were made, so
    // running it anyway would report a change Tori declined to make.
    backstopOk = false;

    await applyCodeAction(
      view,
      A,
      { title: "Fix all", edit: editOver([A, B]), command: { command: "after" } },
      io().io,
    );

    expect(commandRuns).toEqual([]);
  });
});

describe("when there is no Tori workspace behind the view", () => {
  it("says so instead of dying inside a promise", async () => {
    // Every client Tori builds is given one, so this is a should-not-happen
    // that has to be legible rather than a TypeError nobody sees.
    plugin = { client: { workspace: {} } };
    const h = io();

    const out = await applyCodeAction(view, A, { title: "Add import", edit: editOver([A]) }, h.io);

    expect(out.kind).toBe("refused");
    expect(h.said[0].message).toContain("no Tori workspace");
  });

  it("hands back no runner at all, so nothing tries to apply through it", () => {
    plugin = null;
    expect(codeActionRunner(view, A, io().io)).toBeNull();
  });
});

describe("an action that turns out to do nothing", () => {
  it("says so, because a silent menu click reads as a broken menu", async () => {
    const h = io();

    const out = await applyCodeAction(view, A, { title: "Empty" }, h.io);

    expect(out).toEqual({ kind: "nothing" });
    expect(h.said[0].message).toContain("Empty");
    expect(h.said[0].kind).toBe("info");
  });
});
