// The save guard for files no watcher covers.
//
// Everything the editor knows about outside writes arrives as `fs://changed`,
// and that only ever fires for a path under a workspace root. An agent's own
// config home is under none of them, so a tab on `~/.claude/CLAUDE.md` is a
// real file with no watcher behind it: the agent rewrites it mid-session, and
// the next save in Tori would have silently written the buffer over the top.
//
// So an out-of-root tab records the file's mtime and re-checks it just before
// writing. In root, nothing changes: the watcher got there first, and a second
// answer read at save time would only ever be staler.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, waitFor } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const IN_ROOT = `${REPO}/src/main.ts`;
const OUT_OF_ROOT = "/home/me/.claude/CLAUDE.md";

/** The mock filesystem, and the one fact this suite turns on. */
let disk: Record<string, string> = {};
let mtime: Record<string, number> = {};
const writes: { path: string; contents: string }[] = [];
const reads: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    const path = String(args?.path ?? "");
    switch (cmd) {
      case "fs_read_file":
        reads.push(path);
        return path in disk ? Promise.resolve(disk[path]) : Promise.reject("ENOENT");
      case "fs_write_file":
        writes.push({ path, contents: String(args.contents) });
        disk[path] = String(args.contents);
        // A real write moves the mtime, which is what keeps the guard from
        // firing on the editor's own save the next time round.
        mtime[path] = (mtime[path] ?? 0) + 1000;
        return Promise.resolve(null);
      case "fs_mtime_ms":
        return Promise.resolve(path in mtime ? mtime[path] : null);
      case "file_exists":
        return Promise.resolve(path in disk);
      case "git_status":
      case "git_diff_file":
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("./lspClient", () => ({
  claimedByLsp: () => false,
  ensureLspFor: () => Promise.resolve(),
  lspPluginFor: () => [],
  lspTargetFor: () => null,
  notifyLspFileChanged: () => {},
  onLspChange: () => () => {},
  setSemanticRefreshListener: () => () => {},
  setCodeLensRefreshListener: () => () => {},
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { emitWith, EDITOR_SAVE } = await import("../../utils/events");

let mounted: ReturnType<typeof render> | null = null;

async function open(path: string) {
  const dirty: { path: string; dirty: boolean }[] = [];
  mounted = render(() => (
    <CodeEditor
      activePath={path}
      openPaths={[path]}
      projectRoot={REPO}
      watchedRoots={[REPO]}
      goto={null}
      onDirty={(p, d) => dirty.push({ path: p, dirty: d })}
      selected={null}
    />
  ));
  await waitFor(() => expect(dirty.length).toBeGreaterThan(0));
  const view = EditorView.findFromDOM(
    mounted.container.querySelector(".cm-editor") as HTMLElement,
  )!;
  // The baseline is taken on open, asynchronously. Waiting for it is the
  // difference between testing the guard and testing a race.
  await waitFor(() => expect(reads).toContain(path));
  return { view, dirty };
}

/** Type into the buffer so there is something worth saving. */
function edit(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

beforeEach(() => {
  disk = { [IN_ROOT]: "in root\n", [OUT_OF_ROOT]: "from disk\n" };
  mtime = { [IN_ROOT]: 1000, [OUT_OF_ROOT]: 1000 };
  writes.length = 0;
  reads.length = 0;
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("saving a file outside every watched root", () => {
  it("refuses to write over an outside edit and resolves it instead", async () => {
    const { view } = await open(OUT_OF_ROOT);
    edit(view, "mine\n");

    // The agent rewrote its own instructions file while the tab sat open. No
    // watcher covers this path, so nothing has told the editor.
    disk[OUT_OF_ROOT] = "theirs\n";
    mtime[OUT_OF_ROOT] = 2000;
    reads.length = 0;

    emitWith(EDITOR_SAVE, undefined);

    // The external-change flow re-reads the file, which is how it decides
    // between a clean reload and a conflict banner.
    await waitFor(() => expect(reads).toContain(OUT_OF_ROOT));
    expect(writes).toEqual([]);
    expect(disk[OUT_OF_ROOT]).toBe("theirs\n");
  });

  it("writes normally when nothing moved under it", async () => {
    const { view } = await open(OUT_OF_ROOT);
    edit(view, "mine\n");

    emitWith(EDITOR_SAVE, undefined);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ path: OUT_OF_ROOT, contents: "mine\n" });
  });

  // Two saves in a row, with no outside write between them. The second one is
  // the regression this pins: without re-recording the mtime after a write, the
  // editor's own save would look like somebody else's edit.
  it("does not mistake its own previous save for an outside edit", async () => {
    const { view } = await open(OUT_OF_ROOT);
    edit(view, "first\n");
    emitWith(EDITOR_SAVE, undefined);
    await waitFor(() => expect(writes).toHaveLength(1));

    edit(view, "second\n");
    emitWith(EDITOR_SAVE, undefined);

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].contents).toBe("second\n");
  });

});

describe("saving a file inside a watched root", () => {
  // The watcher owns this case. A moved mtime here means `fs://changed` has
  // already raised the conflict, and a second check at save time would only
  // add a way for the two answers to disagree.
  it("is unaffected by a moved mtime", async () => {
    const { view } = await open(IN_ROOT);
    edit(view, "mine\n");

    disk[IN_ROOT] = "theirs\n";
    mtime[IN_ROOT] = 9999;

    emitWith(EDITOR_SAVE, undefined);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ path: IN_ROOT, contents: "mine\n" });
  });
});
