import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEffect } from "solid-js";
import { render, screen, waitFor } from "@solidjs/testing-library";

// A `sway://` tab is a view, not a file, and the whole point of the convention
// is what it is kept *out* of: CodeEditor's buffers (and so the language server),
// the persisted strip, and the folder it does not lexically live under.
//
// The exclusions are all one-liners spread across three modules, which is exactly
// the shape that rots silently. This suite mounts the real pane and asserts what
// CodeEditor is actually handed.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";

let existing = new Set<string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "file_exists":
        return Promise.resolve(existing.has(String(args.path)));
      case "fs_read_dir":
      case "git_log":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
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

// Stands in for CodeMirror, and records every value it is handed. A buffer is
// only ever built for `activePath`, and `lspPluginFor` is only ever called while
// building one, so "CodeEditor was never given the id" is what "no language
// server was asked about it" reduces to.
const handed: { activePath: string | null; openPaths: string[] }[] = [];
let mountedCodeEditor = 0;
vi.mock("./CodeEditor", () => ({
  default: (props: { activePath: string | null; openPaths: string[] }) => {
    mountedCodeEditor++;
    createEffect(() => handed.push({ activePath: props.activePath, openPaths: [...props.openPaths] }));
    return null;
  },
}));
vi.mock("./lspClient", () => ({ ensureLsp: () => {} }));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR, PURGE_UNDER_PATH } = await import("../../utils/events");
const { syntheticId } = await import("../../utils/syntheticTabs");

const LOG = syntheticId("log", REPO);
const FILE = `${REPO}/src/a.ts`;

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

const EMPTY_PANE = /Open a file from the tree/;

/** The most recent set of props CodeEditor was rendered with. */
const last = () => handed[handed.length - 1];

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor() {
  mounted = render(() => <Editor selected={selection as never} />);
  await waitFor(() => expect(listening.ready).toBe(true));
}

async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
}

beforeEach(() => {
  localStorage.clear();
  handed.length = 0;
  mountedCodeEditor = 0;
  existing = new Set([FILE]);
  listening.ready = false;
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("a sway:// tab in the editor pane", () => {
  it("opens as a tab without mounting the code editor at all", async () => {
    await mountEditor();
    await open(LOG);

    expect(mountedCodeEditor).toBe(0);
    // The kind in the id is what picks the view, so this is also the check that
    // the pane routes `log` somewhere rather than rendering an empty tab.
    await waitFor(() => expect(screen.getByText("No commits yet.")).toBeTruthy());
  });

  it("hands the code editor no active path and no buffer to keep", async () => {
    await mountEditor();
    await open(FILE);
    await open(LOG);

    await waitFor(() => expect(last().activePath).toBeNull());
    // The file beside it still holds its buffer; only the view is absent.
    expect(last().openPaths).toEqual([FILE]);
    expect(handed.every((h) => h.openPaths.every((p) => !p.startsWith("sway://")))).toBe(true);
    expect(handed.every((h) => !h.activePath?.startsWith("sway://"))).toBe(true);
  });

  it("is not written to the persisted strip", async () => {
    await mountEditor();
    await open(FILE);
    await open(LOG);

    await waitFor(() => expect(localStorage.getItem("sway.editor.tabs.v1")).toContain(FILE));
    expect(localStorage.getItem("sway.editor.tabs.v1")).not.toContain("sway://");
  });

  it("takes no preview toggle from a workspace folder that looks like a file", async () => {
    // The suffix tests that pick Markdown/SVG/image read the tab id, and a
    // synthetic id ends in the workspace path. A folder called `notes.md` would
    // otherwise hand the commit log a source-vs-render toggle.
    const odd = `${REPO}/notes.md`;
    mounted = render(() => <Editor selected={{ ...selection, folderPath: odd } as never} />);
    await waitFor(() => expect(listening.ready).toBe(true));
    await open(syntheticId("log", odd));

    expect(screen.queryByTitle(/Preview: render this/)).toBeNull();
    await waitFor(() => expect(screen.getByText("No commits yet.")).toBeTruthy());
  });

  it("closes with the workspace it names, even though its id is not under it", async () => {
    await mountEditor();
    await open(LOG);

    emitWith(PURGE_UNDER_PATH, { path: REPO });

    await waitFor(() => expect(screen.getByText(EMPTY_PANE)).toBeTruthy());
  });
});
