// A pane's id changing under the editor (plan phase 3 of the reveal-path plan).
// A split re-keys the editor's pane and a worktree switch re-keys it again, so
// the id it is rendered under is not the id it keeps. The claim under test is
// that the view is *moved* to the pane that replaces it rather than rebuilt,
// and that a view nobody claims is still destroyed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal, For } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const ONE = `${REPO}/one.ts`;

let disk: Record<string, string> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    const path = String(args?.path ?? "");
    switch (cmd) {
      case "fs_read_file":
        return path in disk ? Promise.resolve(disk[path]) : Promise.reject("ENOENT");
      case "file_exists":
        return Promise.resolve(path in disk);
      case "git_diff_file":
      case "git_status":
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
  retainLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");

let mounted: ReturnType<typeof render> | null = null;

/** Panes whose ids the test can rewrite, each holding the same file, rendered
 *  the way the shell does it: the host elements are keyed by pane id too, so a
 *  re-key throws away the old box and hands over a new one. */
async function mountPanes(ids: string[]) {
  const [panes, setPanes] = createSignal(ids);
  const [hosts, setHosts] = createSignal<Record<string, HTMLElement>>({});
  const hold = (id: string) => (el: HTMLElement) => setHosts((prev) => ({ ...prev, [id]: el }));
  mounted = render(() => (
    <>
      <For each={panes()}>{(id) => <div ref={hold(id)} data-pane={id} />}</For>
      <CodeEditor
        paneIds={panes()}
        paneHost={(id) => hosts()[id]}
        panePath={() => ONE}
        paneHidden={() => false}
        focusedPaneId={panes()[0]}
        openPaths={[ONE]}
        projectRoot={REPO}
        goto={null}
        onDirty={() => {}}
        selected={null}
      />
    </>
  ));
  const viewIn = (id: string) => {
    const el = hosts()[id]?.querySelector(".cm-editor");
    return el ? EditorView.findFromDOM(el as HTMLElement) : null;
  };
  await waitFor(() => expect(viewIn(ids[0])?.state.sliceDoc()).toBe(disk[ONE]));
  return { viewIn, setPanes };
}

const editorCount = () => document.querySelectorAll(".cm-editor").length;

beforeEach(() => {
  disk = { [ONE]: "one\ntwo\nthree\n" };
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("a pane id changing under the editor", () => {
  it("moves the view to the pane that replaces it instead of rebuilding it", async () => {
    const { viewIn, setPanes } = await mountPanes(["main"]);
    const before = viewIn("main")!;
    before.dispatch({ changes: { from: 0, insert: "edited\n" } });

    setPanes(["pane-1"]);
    await waitFor(() => expect(viewIn("pane-1")).toBeTruthy());
    // The same object, not an equal one: a rebuilt view would read the same
    // document off the buffer and pass every content check while having thrown
    // away the measured heights and the reader's place.
    expect(viewIn("pane-1")).toBe(before);
    expect(viewIn("pane-1")!.state.sliceDoc().startsWith("edited")).toBe(true);
  });

  it("destroys a view no pane claimed", async () => {
    const { setPanes } = await mountPanes(["left", "right"]);
    await waitFor(() => expect(editorCount()).toBe(2));

    setPanes(["left"]);
    // Parking is deliberately outlived by one task, so the pane arriving in the
    // same flush can claim it; nothing claims this one.
    await waitFor(() => expect(editorCount()).toBe(1));
  });
});
