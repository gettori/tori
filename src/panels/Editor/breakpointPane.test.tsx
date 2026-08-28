import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, waitFor, cleanup } from "@solidjs/testing-library";

// Breakpoints from the pane's side.
//
// `breakpoints.ts` owns the rules, `breakpointGutter.ts` owns the positions and
// `debugBreakpoints.ts` owns the wire; all three are tested on their own. This
// is the part none of them can see: that a click in the gutter reaches the
// store, that the pane's answer comes back with the right state on it, and that
// a breakpoint is still there after the app has been closed and opened again.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

type Mark = { line: number; state: "pending" | "armed" | "bound" };
type CodeProps = {
  activePath: string | null;
  breakpoints?: readonly Mark[];
  onToggleBreakpoint?: (path: string, line: number) => void;
  onBreakpointsMoved?: (path: string, lines: number[], docLines: number) => void;
  onDirty?: (path: string, dirty: boolean) => void;
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "file_exists":
        return Promise.resolve(true);
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));

// The real editor is all of CodeMirror and owns none of this. The stand-in is
// how this suite plays back the one gesture that makes a breakpoint.
let code: CodeProps | null = null;
vi.mock("./CodeEditor", () => ({
  default: (p: CodeProps) => {
    code = p;
    return null;
  },
}));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR, FILE_RENAMED, PURGE_UNDER_PATH } = await import(
  "../../utils/events"
);
const { breakpointMarks } = await import("../../utils/debugBreakpoints");

/** A workspace of its own per test: the store is a module singleton, and a
 *  shared key would leak one test's breakpoints into the next. */
let counter = 0;
function workspace() {
  const repo = `/space/proj/ws${counter++}`;
  return { repo, file: `${repo}/src/a.ts` };
}

async function mountAt(repo: string) {
  const [selected] = createSignal<unknown>({
    spaceName: "space",
    projectName: "proj",
    projectPath: "/space/proj",
    folderPath: repo,
    branch: "main",
    projectKind: "plain",
  });
  render(() => <Editor selected={selected() as never} />);
  await waitFor(() => expect(listening.ready).toBe(true));
}

async function openFile(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(code?.activePath).toBe(path));
}

beforeEach(() => {
  code = null;
  listening.ready = false;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("the gutter click", () => {
  it("sets a breakpoint and takes it away again", async () => {
    const { repo, file } = workspace();
    await mountAt(repo);
    await openFile(file);
    expect(code!.breakpoints).toEqual([]);

    code!.onToggleBreakpoint!(file, 12);
    await waitFor(() => expect(code!.breakpoints).toEqual([{ line: 12, state: "armed" }]));

    // The same gesture has to undo itself: there is nowhere else to click.
    code!.onToggleBreakpoint!(file, 12);
    await waitFor(() => expect(code!.breakpoints).toEqual([]));
  });

  it("follows an edit that moved it", async () => {
    const { repo, file } = workspace();
    await mountAt(repo);
    await openFile(file);
    code!.onToggleBreakpoint!(file, 12);
    await waitFor(() => expect(code!.breakpoints).toHaveLength(1));

    code!.onBreakpointsMoved!(file, [22], 80);
    await waitFor(() => expect(code!.breakpoints).toEqual([{ line: 22, state: "armed" }]));
  });

  it("keeps a line the shortened buffer can no longer hold", async () => {
    const { repo, file } = workspace();
    await mountAt(repo);
    await openFile(file);
    code!.onToggleBreakpoint!(file, 12);
    code!.onToggleBreakpoint!(file, 90);
    await waitFor(() => expect(code!.breakpoints).toHaveLength(2));

    // A checkout can leave the buffer shorter than the store. The buffer cannot
    // report a line past its own end, and taking its answer as the whole truth
    // would delete by hand what was set by hand.
    code!.onBreakpointsMoved!(file, [12], 40);
    await waitFor(() => expect(code!.breakpoints).toEqual([
      { line: 12, state: "armed" },
      { line: 90, state: "armed" },
    ]));
  });
});

describe("an unsaved buffer", () => {
  it("shows pending, and arms again on the save", async () => {
    const { repo, file } = workspace();
    await mountAt(repo);
    await openFile(file);
    code!.onToggleBreakpoint!(file, 5);
    await waitFor(() => expect(code!.breakpoints).toEqual([{ line: 5, state: "armed" }]));

    code!.onDirty!(file, true);
    // The line names text the adapter has never seen, so it says so rather than
    // claiming it will stop.
    await waitFor(() => expect(code!.breakpoints).toEqual([{ line: 5, state: "pending" }]));

    code!.onDirty!(file, false);
    await waitFor(() => expect(code!.breakpoints).toEqual([{ line: 5, state: "armed" }]));
  });
});

describe("when the file moves or goes", () => {
  it("follows a rename", async () => {
    const { repo, file } = workspace();
    const moved = `${repo}/src/renamed.ts`;
    await mountAt(repo);
    await openFile(file);
    code!.onToggleBreakpoint!(file, 12);
    await waitFor(() => expect(code!.breakpoints).toHaveLength(1));

    emitWith(FILE_RENAMED, { from: file, to: moved });

    // Left behind, they would arm the old name on every run and show the file
    // you are actually looking at as bare.
    await waitFor(() => expect(breakpointMarks(repo, moved)).toEqual([{ line: 12, state: "armed" }]));
    expect(breakpointMarks(repo, file)).toEqual([]);
  });

  it("goes with a trashed folder", async () => {
    const { repo, file } = workspace();
    await mountAt(repo);
    await openFile(file);
    code!.onToggleBreakpoint!(file, 12);
    await waitFor(() => expect(code!.breakpoints).toHaveLength(1));

    emitWith(PURGE_UNDER_PATH, { path: `${repo}/src` });

    // A breakpoint on a trashed file has no gutter left to click, so nothing
    // could ever remove it, and it would go out in every future run's
    // `setBreakpoints` naming a path that does not exist.
    await waitFor(() => expect(breakpointMarks(repo, file)).toEqual([]));
  });

  it("stops waiting on a save that can no longer come", async () => {
    const { repo, file } = workspace();
    await mountAt(repo);
    await openFile(file);
    code!.onToggleBreakpoint!(file, 5);
    code!.onDirty!(file, true);
    await waitFor(() => expect(code!.breakpoints).toEqual([{ line: 5, state: "pending" }]));

    emitWith(PURGE_UNDER_PATH, { path: `${repo}/src` });
    await waitFor(() => expect(breakpointMarks(repo, file)).toEqual([]));

    // And the path is not left in the pending set: a name reused later would
    // arrive already waiting on a save nobody made.
    code!.onToggleBreakpoint!(file, 5);
    expect(breakpointMarks(repo, file)).toEqual([{ line: 5, state: "armed" }]);
  });
});

describe("across a restart", () => {
  it("is still on the same line", async () => {
    const { repo, file } = workspace();
    // Driven through a fresh copy of the module, then read from a second fresh
    // copy: that is what closing and reopening the app does to a module
    // singleton, and the only thing that can carry a line across it is storage.
    vi.resetModules();
    const before = await import("../../utils/debugBreakpoints");
    before.toggleBreakpointAt(repo, file, 7);

    vi.resetModules();
    const after = await import("../../utils/debugBreakpoints");
    expect(after.breakpointMarks(repo, file)).toEqual([{ line: 7, state: "armed" }]);
  });
});
