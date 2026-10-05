// Pane-scoped tab keys on the editor side (plan phase 6): Cmd+W, Cmd+1..9 and
// Ctrl+Tab act on the file tabs only while the file pane holds pane focus, and
// Cmd+W rides closeTab, so a dirty buffer is asked about before it is lost.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];

const bridge = vi.hoisted(() => ({
  onDirty: null as ((path: string, dirty: boolean) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "feature", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 1, behind: 0, has_upstream: true });
      case "file_exists":
        return Promise.resolve(false);
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));
// The buffers live in CodeEditor; this suite needs only its dirty-report arrow,
// so the stub hands that callback out and renders nothing.
vi.mock("./CodeEditor", () => ({
  default: (props: { onDirty: (path: string, dirty: boolean) => void }) => {
    bridge.onDirty = props.onDirty;
    return null;
  },
}));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { enterRoots } = await import("../../utils/gitActions");
const { emitWith, emit, OPEN_IN_EDITOR, CLOSE_TAB, TAB_JUMP, TAB_CYCLE, GIT_STAGE_ACTIVE } =
  await import("../../utils/events");
const { ensureEnvelope, resetPaneLayoutModel, seedTwoPane, setFocusedPane } = await import(
  "../../layout/layoutStore"
);

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

const seed = () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true });

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor() {
  mounted = render(() => <Editor selected={selection as never} />);
  await waitFor(() => expect(invokes.some((i) => i.cmd === "git_status")).toBe(true));
  await waitFor(() => expect(listening.ready).toBe(true));
}

const EMPTY_PANE = /Open a file from the tree/;

async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
}

/** Which file is active, read through staging: layout-independent, since jsdom
 *  folds the whole strip into the overflow menu. */
async function expectActive(rel: string) {
  const before = invokes.filter((i) => i.cmd === "git_stage").length;
  emitWith(GIT_STAGE_ACTIVE, null);
  await waitFor(() => {
    const calls = invokes.filter((i) => i.cmd === "git_stage");
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1].args).toEqual({ projectPath: REPO, paths: [rel] });
  });
}

beforeEach(async () => {
  enterRoots([]);
  localStorage.clear();
  invokes.length = 0;
  listening.ready = false;
  bridge.onDirty = null;
  resetPaneLayoutModel();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("pane-scoped keys on the file pane", () => {
  it("ignores every tab key while the terminal pane holds pane focus", async () => {
    await mountEditor();
    ensureEnvelope(REPO, seed);
    setFocusedPane(REPO, "left");
    await open(`${REPO}/src/a.ts`);
    await open(`${REPO}/src/b.ts`);

    emitWith(TAB_JUMP, { index: 0 });
    await expectActive("src/b.ts");
    emit(CLOSE_TAB);
    await Promise.resolve();
    expect(screen.queryByText(EMPTY_PANE)).toBeNull();
    await expectActive("src/b.ts");
  });

  it("jumps and cycles the file tabs while the file pane holds pane focus", async () => {
    await mountEditor();
    ensureEnvelope(REPO, seed);
    setFocusedPane(REPO, "right");
    await open(`${REPO}/src/a.ts`);
    await open(`${REPO}/src/b.ts`);

    emitWith(TAB_JUMP, { index: 0 });
    await expectActive("src/a.ts");
    emit(TAB_CYCLE);
    await expectActive("src/b.ts");
  });

  it("Cmd+W closes a clean file at once, handing the slot leftward", async () => {
    await mountEditor();
    ensureEnvelope(REPO, seed);
    setFocusedPane(REPO, "right");
    await open(`${REPO}/src/a.ts`);
    await open(`${REPO}/src/b.ts`);

    emit(CLOSE_TAB);
    await expectActive("src/a.ts");
    emit(CLOSE_TAB);
    await waitFor(() => expect(screen.getByText(EMPTY_PANE)).toBeTruthy());
  });

  it("Cmd+W asks before discarding a dirty file, and cancel keeps it", async () => {
    await mountEditor();
    ensureEnvelope(REPO, seed);
    setFocusedPane(REPO, "right");
    await open(`${REPO}/src/a.ts`);
    await waitFor(() => expect(bridge.onDirty).not.toBeNull());
    bridge.onDirty!(`${REPO}/src/a.ts`, true);

    emit(CLOSE_TAB);
    await screen.findByText("Discard unsaved changes to a.ts?");
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText(/Discard unsaved/)).toBeNull());
    expect(screen.queryByText(EMPTY_PANE)).toBeNull();

    emit(CLOSE_TAB);
    await screen.findByText("Discard unsaved changes to a.ts?");
    fireEvent.click(screen.getByText("Discard"));
    await waitFor(() => expect(screen.getByText(EMPTY_PANE)).toBeTruthy());
  });
});
