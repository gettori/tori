// That the debug hover is actually in the editor.
//
// `debugHover.ts` is tested on its own, and a passing extension nobody added is
// still nothing anybody can use ([[lesson_a_registered_command_with_no_caller_is_not_shipped]]).
// The hover has no prop to assert through the way the frame highlight does, so
// the real CodeEditor is mounted and its state is asked which file the hover
// thinks it is in: absent means the extension never reached the buffer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const FILE = `${REPO}/a.ts`;
const DISK = "const x = 1\nconst y = 2\n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "fs_read_file":
        return Promise.resolve(DISK);
      case "git_status":
      case "git_diff_file":
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("./lspClient", () => ({
  claimedByLsp: () => false,
  ensureLspFor: () => Promise.resolve(),
  lspPluginFor: () => [],
  lspTargetFor: () => null,
  lspTargets: () => [],
  executeServerCommand: () => Promise.resolve(null),
  notifyLspFileChanged: () => {},
  onLspChange: () => () => {},
  setSemanticRefreshListener: () => () => {},
  setCodeLensRefreshListener: () => () => {},
  stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { debugHoverFile } = await import("./debugHover");

let mounted: ReturnType<typeof render> | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the buffer the editor built", () => {
  it("carries the debug hover, told which file it is in", async () => {
    mounted = render(() => (
      <CodeEditor
        activePath={FILE}
        openPaths={[FILE]}
        projectRoot={REPO}
        goto={null}
        onDirty={() => {}}
        selected={null}
      />
    ));

    const viewNow = () =>
      EditorView.findFromDOM(mounted!.container.querySelector(".cm-editor") as HTMLElement);
    // The buffer's own extensions arrive with the file, not with the mount.
    await waitFor(() => expect(viewNow()?.state.doc.toString()).toBe(DISK));
    const view = viewNow();

    // The path is what the hover checks against the stack, so a buffer that has
    // the extension but no path would answer nothing, everywhere, forever.
    expect(view).toBeTruthy();
    expect(view!.state.facet(debugHoverFile)).toBe(FILE);
  });
});
