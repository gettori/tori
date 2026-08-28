// #46, end to end: the markdown preview renders the open buffer, not the file.
//
// The unit test beside this one (`utils/liveBuffer.test.ts`) covers the store's
// rules. What it cannot answer is the thing the ticket is about: two components
// that never import each other have to agree on one document, across a boundary
// that exists precisely so the eager side never touches CodeMirror. So this
// mounts both real components over one mocked filesystem and checks they agree,
// including in the case that made this a bug - text that exists only in the
// buffer, because it has not been saved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";
import { EditorView } from "@codemirror/view";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const NOTES = `${REPO}/notes.md`;
const CODE = `${REPO}/main.ts`;

const ON_DISK = "# On disk\n";

/** The mock filesystem, and every read of it: "did the preview go to disk?" is
 *  half of what this suite asserts. */
let disk: Record<string, string> = {};
let reads: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    const path = String(args?.path ?? "");
    switch (cmd) {
      case "fs_read_file":
        reads.push(path);
        return path in disk ? Promise.resolve(disk[path]) : Promise.reject("ENOENT");
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
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
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
  stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { default: MarkdownPreview } = await import("./MarkdownPreview");
const { clearLiveBuffers, bufferTextOf, handOff, takeHandOff } = await import("../../utils/liveBuffer");
const { emitWith, AGENT_FILES_WRITTEN } = await import("../../utils/events");
type AgentFilesWritten = { paths: string[] };

let editor: ReturnType<typeof render> | null = null;
let preview: ReturnType<typeof render> | null = null;

/** Open a file in the real editor and wait for its buffer to exist. Returns the
 *  handles a test needs to act on it: the view to type into, and the two props
 *  the pane drives when the preview toggle is flipped or a tab is closed. */
async function openInEditor(path: string) {
  const dirty: string[] = [];
  const [activePath, setActivePath] = createSignal<string | null>(path);
  const [openPaths, setOpenPaths] = createSignal<string[]>([path]);
  editor = render(() => (
    <CodeEditor
      activePath={activePath()}
      openPaths={openPaths()}
      projectRoot={REPO}
      goto={null}
      onDirty={(p) => dirty.push(p)}
      selected={null}
    />
  ));
  await waitFor(() => expect(dirty.length).toBeGreaterThan(0));
  const view = EditorView.findFromDOM(editor.container.querySelector(".cm-editor") as HTMLElement)!;
  return {
    view,
    /** Flip to the preview: the pane nulls `activePath` and hides the editor,
     *  which is why the buffer being previewed is never the shown one. */
    showPreview: () => setActivePath(null),
    closeTab: () => setOpenPaths([]),
    /** An agent turn rewriting the file, announced the way ChatView announces
     *  it. The internal bus, not Tauri's, so the mocked `listen` is not in the
     *  way and the editor's own debounce is exercised rather than stepped over. */
    agentWrites: (contents: string) => {
      disk[path] = contents;
      emitWith<AgentFilesWritten>(AGENT_FILES_WRITTEN, { paths: [path] });
    },
  };
}

/** Mount the real preview on a path and wait for it to render something. */
async function showPreviewOf(path: string) {
  preview = render(() => <MarkdownPreview path={path} />);
  await waitFor(() => expect(preview!.container.querySelector(".tree-empty")).toBeNull());
  return preview.container;
}

/** What the rendered output currently says, whitespace-insensitive. */
function rendered(): string {
  return preview!.container.textContent ?? "";
}

beforeEach(() => {
  disk = { [NOTES]: ON_DISK, [CODE]: "export const a = 1;\n" };
  reads = [];
  clearLiveBuffers();
});
afterEach(() => {
  preview?.unmount();
  preview = null;
  editor?.unmount();
  editor = null;
});

describe("previewing a file that is open in the editor", () => {
  it("renders the unsaved edits rather than what the file still says", async () => {
    // The whole ticket. Before this, toggling to preview after typing showed
    // the version on disk, which is a different document from the one on
    // screen a moment earlier.
    const { view, showPreview } = await openInEditor(NOTES);
    view.dispatch({ changes: { from: 0, insert: "# Typed, never saved\n\n" }, userEvent: "input.type" });
    showPreview();

    await showPreviewOf(NOTES);

    expect(rendered()).toContain("Typed, never saved");
    expect(preview!.container.querySelector("h1")?.textContent).toBe("Typed, never saved");
  });

  it("does not read the file at all while a buffer holds it", async () => {
    const { showPreview } = await openInEditor(NOTES);
    showPreview();
    const before = reads.length;

    await showPreviewOf(NOTES);

    // One read, by the editor, when it opened the buffer. The preview adds
    // none: disk is not a second opinion to reconcile, it is the fallback for
    // having no buffer at all.
    expect(reads.length).toBe(before);
    expect(reads).toEqual([NOTES]);
  });

  it("follows an agent write landing while the preview is showing", async () => {
    const { showPreview, agentWrites } = await openInEditor(NOTES);
    showPreview();
    await showPreviewOf(NOTES);
    expect(rendered()).toContain("On disk");

    agentWrites("# Rewritten by an agent\n");

    // No toggle in between: the buffer is reloaded in the background (which is
    // where a previewed buffer always is), and the preview re-renders off the
    // same publish the editor makes for its own dirty check.
    await waitFor(() => expect(rendered()).toContain("Rewritten by an agent"));
  });
});

describe("previewing a file no buffer holds", () => {
  it("falls back to the file, so a restored tab nobody clicked still renders", async () => {
    await showPreviewOf(NOTES);

    expect(rendered()).toContain("On disk");
    expect(reads).toEqual([NOTES]);
  });

  it("goes back to the file once the tab is closed", async () => {
    // The store is bounded by what is open. A closed tab whose text stayed
    // behind would render its buffer forever, including after somebody else
    // rewrote the file.
    const { view, closeTab } = await openInEditor(NOTES);
    view.dispatch({ changes: { from: 0, insert: "# Unsaved\n\n" }, userEvent: "input.type" });
    expect(bufferTextOf(NOTES)).toContain("Unsaved");

    closeTab();

    await waitFor(() => expect(bufferTextOf(NOTES)).toBeUndefined());
    await showPreviewOf(NOTES);
    expect(rendered()).toContain("On disk");
  });
});

describe("what the editor publishes", () => {
  it("publishes nothing for a file with no rendered view", async () => {
    // The store holds whole documents. Every open buffer paying for a second
    // copy of itself, so that markdown can have one, is the cost this rules out.
    await openInEditor(CODE);
    expect(bufferTextOf(CODE)).toBeUndefined();
  });

  it("publishes a buffer the moment it is built, before anything is typed", async () => {
    // A hot-exit stash and a reopened tab both arrive holding text the file
    // does not have, and neither fires a document change to notice it by.
    await openInEditor(NOTES);
    expect(bufferTextOf(NOTES)).toBe(ON_DISK);
  });
});

describe("carrying the reading position across the toggle", () => {
  it("takes the position the source view left behind", async () => {
    handOff(NOTES, "source", 0.5);

    await showPreviewOf(NOTES);

    // Consumed: the preview has it now, so nothing is left for a later mount
    // to be positioned by twice.
    expect(takeHandOff(NOTES, "preview")).toBeUndefined();
    // Where it actually lands is a pixel measurement, and jsdom measures every
    // element as zero-sized. That is Phase 12's smoke.
  });

  it("replaces a stale position when the source lands on the cursor instead", async () => {
    // Scrolled most of the way down, then swapped to another tab and back. The
    // source view is at the cursor now, so the old claim has to go: left
    // pending, the next preview would open where the file was two swaps ago.
    handOff(NOTES, "source", 0.9);

    await openInEditor(NOTES);

    expect(takeHandOff(NOTES, "preview")).toBe(0);
  });

  it("leaves a position belonging to the source view alone", async () => {
    // The preview was never shown, so nothing consumed it; a swap back into
    // the editor must still find it there rather than scroll to line one.
    handOff(NOTES, "preview", 0.5);

    await showPreviewOf(NOTES);

    expect(takeHandOff(NOTES, "source")).toBe(0.5);
  });
});

describe("what the preview will not render", () => {
  it("strips a script the buffer is holding", async () => {
    const { view, showPreview } = await openInEditor(NOTES);
    view.dispatch({
      changes: { from: 0, insert: "<script>window.pwned = 1</script>\n\n" },
      userEvent: "input.type",
    });
    showPreview();

    const container = await showPreviewOf(NOTES);

    // Reading the buffer changed where the markdown comes from, not what may
    // be done with it: unsaved text is still untrusted text.
    expect(container.querySelector("script")).toBeNull();
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  it("still resolves a relative image through the asset protocol", async () => {
    const { view, showPreview } = await openInEditor(NOTES);
    view.dispatch({ changes: { from: 0, insert: "![shot](img/shot.png)\n\n" }, userEvent: "input.type" });
    showPreview();

    const container = await showPreviewOf(NOTES);

    const src = container.querySelector("img")?.getAttribute("src") ?? "";
    expect(src).toContain("asset://localhost/");
    expect(decodeURIComponent(src)).toContain(`${REPO}/img/shot.png`);
  });
});
