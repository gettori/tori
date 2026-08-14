import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEffect } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { tab } from "../../test/tabs";
import { rightClick } from "../../test/menus";

// A `sway://` tab is a view, not a file, and the whole point of the convention
// is what it is kept *out* of: CodeEditor's buffers (and so the language server),
// the persisted strip, and the folder it does not lexically live under.
//
// The exclusions are all one-liners spread across three modules, which is exactly
// the shape that rots silently. This suite mounts the real pane and asserts what
// CodeEditor is actually handed.

import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorHarness";

installResizeObserver();

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
      case "git_commit_detail":
        return Promise.resolve({
          sha: String(args.sha),
          short: String(args.sha).slice(0, 7),
          subject: "the commit that was asked for",
          body: "",
          author: "t",
          email: "t@t",
          relative_date: "an hour ago",
          parents: ["f".repeat(40)],
          refs: [],
          files: [],
        });
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
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, onWith, OPEN_IN_EDITOR, PURGE_UNDER_PATH } = await import("../../utils/events");
const { syntheticId, parseSyntheticId } = await import("../../utils/syntheticTabs");

const LOG = syntheticId("log", REPO);
const FILE = `${REPO}/src/a.ts`;

const selection = selectionFor(REPO);

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

    expect(screen.queryByLabelText(/Preview: render this/)).toBeNull();
    await waitFor(() => expect(screen.getByText("No commits yet.")).toBeTruthy());
  });

  it("closes with the workspace it names, even though its id is not under it", async () => {
    await mountEditor();
    await open(LOG);

    emitWith(PURGE_UNDER_PATH, { path: REPO });

    await waitFor(() => expect(screen.getByText(EMPTY_PANE)).toBeTruthy());
  });

  it("opens a file's own history from its tab, by a path git can use", async () => {
    // The pathspec has to be repo-relative: an absolute one works by accident
    // today and stops working the moment the same tab is read anywhere else.
    await mountEditor();
    await open(FILE);
    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, (d) => opened.push(d.path));

    fireEvent.contextMenu(tab("a.ts"));
    fireEvent.click(await screen.findByText("File history"));

    expect(parseSyntheticId(opened[0])).toEqual({ kind: "history", arg: "src/a.ts", workspace: REPO });
    off();
  });

  it("routes each kind of id to its own view, and none of them to the code editor", async () => {
    // The routing is three one-line `Show`s in the pane; without this the whole
    // commit tab could be unreachable and every other test would still pass.
    await mountEditor();
    await open(syntheticId("commit", REPO, "a".repeat(40)));
    await waitFor(() => expect(screen.getByText("the commit that was asked for")).toBeTruthy());

    await open(syntheticId("history", REPO, "src/a.ts"));
    await waitFor(() => expect(screen.getByText("following renames")).toBeTruthy());
    expect(screen.getByText("src/a.ts")).toBeTruthy();

    expect(mountedCodeEditor).toBe(0);
  });

  it("offers no history for a view, which has none", async () => {
    await mountEditor();
    await open(LOG);

    fireEvent.contextMenu(tab("Commit log"));

    expect(screen.queryByText("File history")).toBeNull();
  });

  // Pinned ahead of the Kobalte migration (skarif2/sway#103, phase 1). The test
  // above proves the view's menu is empty; this proves what the tab does with
  // the right-click *instead*, which is the half a migration can silently lose.
  // Kobalte's ContextMenu.Trigger always calls `preventDefault` unless it is
  // `disabled`, so the synthetic case has to become `disabled` rather than an
  // early return, and this is what catches it if it does not.
  //
  // Selector coupling, i.e. what a migration has to rewrite here:
  //   - `defaultPrevented` on the dispatched event: STABLE, and the contract.
  //   - `role="menu"` for the surface: STABLE, Kobalte's Content sets it too.
  //   - `tab()` resolves to the *ghost* copy of the strip (see src/test/tabs.ts:
  //     jsdom gives the bar no geometry, so the visible row keeps almost
  //     nothing). Phase 4 plans a menu-free ghost row to stop `renderTab` from
  //     mounting menu machinery twice; the moment it lands, these two tests must
  //     reach the visible copy instead, or they will right-click a tab that
  //     deliberately no longer has a menu.
  describe("what a right-click on a tab claims", () => {
    it("claims the event on a file tab, which answers with its own menu", async () => {
      await mountEditor();
      await open(FILE);

      expect(rightClick(tab("a.ts"))).toBe(true);
      expect(await screen.findByRole("menu")).toBeTruthy();
    });

    it("leaves the event alone on a view, so the browser's own menu survives", async () => {
      // A view has no file behind it, so Sway has nothing to offer and the
      // browser's menu (copy, inspect) is more useful than an empty surface.
      await mountEditor();
      await open(LOG);

      expect(rightClick(tab("Commit log"))).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });
});
