import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { createEffect } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { tab, closeOf } from "../../test/tabs";
import { pointerClick, rightClick } from "../../test/menus";

// A `tori://` tab is a view, not a file, and the whole point of the convention
// is what it is kept *out* of: CodeEditor's buffers (and so the language server),
// the persisted strip, and the folder it does not lexically live under.
//
// The exclusions are all one-liners spread across three modules, which is exactly
// the shape that rots silently. This suite mounts the real pane and asserts what
// CodeEditor is actually handed.

import { installResizeObserver, selectionFor, EMPTY_PANE } from "./__fixtures__/editorAgent";
import { installAnimationFrame } from "../../test/frames";

installResizeObserver();
// This suite right-clicks tabs, so it needs the row a browser would draw rather
// than the measuring ghost. See the helper for why the two differ in jsdom.
installAnimationFrame();

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
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, onWith, OPEN_IN_EDITOR, PURGE_UNDER_PATH } = await import("../../utils/events");
const { syntheticId, parseSyntheticId } = await import("../../utils/syntheticTabs");

const GRAPH = syntheticId("graph", REPO);
const FILE = `${REPO}/src/a.ts`;

const selection = selectionFor(REPO);

/** The most recent set of props CodeEditor was rendered with. */
const last = () => handed[handed.length - 1];

let mounted: ReturnType<typeof render> | null = null;

async function mountEditor() {
  mounted = render(() => (
      <>
        <Editor selected={selection as never} />
        <PaneView pinKind="file" />
      </>
    ));
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

describe("a tori:// tab in the editor pane", () => {
  it("opens as a tab without mounting the code editor at all", async () => {
    await mountEditor();
    await open(GRAPH);

    expect(mountedCodeEditor).toBe(0);
    // The kind in the id is what picks the view, so this is also the check that
    // the pane routes `log` somewhere rather than rendering an empty tab.
    await waitFor(() => expect(screen.getByText("No commits yet.")).toBeTruthy());
  });

  it("hands the code editor no active path and no buffer to keep", async () => {
    await mountEditor();
    await open(FILE);
    await open(GRAPH);

    await waitFor(() => expect(last().activePath).toBeNull());
    // The file beside it still holds its buffer; only the view is absent.
    expect(last().openPaths).toEqual([FILE]);
    expect(handed.every((h) => h.openPaths.every((p) => !p.startsWith("tori://")))).toBe(true);
    expect(handed.every((h) => !h.activePath?.startsWith("tori://"))).toBe(true);
  });

  it("is not written to the persisted strip", async () => {
    await mountEditor();
    await open(FILE);
    await open(GRAPH);

    await waitFor(() => expect(localStorage.getItem("tori.editor.tabs.v1")).toContain(FILE));
    expect(localStorage.getItem("tori.editor.tabs.v1")).not.toContain("tori://");
  });

  it("takes no preview toggle from a workspace folder that looks like a file", async () => {
    // The suffix tests that pick Markdown/SVG/image read the tab id, and a
    // synthetic id ends in the workspace path. A folder called `notes.md` would
    // otherwise hand the graph a source-vs-render toggle.
    const odd = `${REPO}/notes.md`;
    mounted = render(() => (
      <>
        <Editor selected={{ ...selection, folderPath: odd } as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(listening.ready).toBe(true));
    await open(syntheticId("graph", odd));

    expect(screen.queryByLabelText(/Preview: render this/)).toBeNull();
    await waitFor(() => expect(screen.getByText("No commits yet.")).toBeTruthy());
  });

  it("closes with the workspace it names, even though its id is not under it", async () => {
    await mountEditor();
    await open(GRAPH);

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
    pointerClick(await screen.findByText("File history"));

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
    await open(GRAPH);

    fireEvent.contextMenu(tab("Graph"));

    expect(screen.queryByText("File history")).toBeNull();
  });

  // Written against the hand-rolled menu (gettori/tori#103, phase 1), now
  // running against Kobalte's (phase 4). The test above proves a view is offered
  // no file history; this proves what the tab does with the right-click itself,
  // which is the half a migration can silently lose.
  //
  // **These need the drawn tab, not the measuring ghost**, which is rendered
  // menu-free and would answer a right-click with nothing. That used to need a
  // second helper; `tab()` reaches the visible row for everyone now
  // (gettori/tori#111). Both assertions below fail against the ghost, the first
  // because no menu opens and the second *vacuously*, which is the worse half:
  // a `disabled` mapping that had been dropped entirely would still have
  // passed.
  describe("what a right-click on a tab claims", () => {
    it("claims the event on a file tab, which answers with its own menu", async () => {
      await mountEditor();
      await open(FILE);

      expect(rightClick(tab("a.ts"))).toBe(true);
      expect(await screen.findByRole("menu")).toBeTruthy();
    });

    it("claims it on a view too, which has the pane actions if not the history", async () => {
      // It used to leave the event to the browser, because a view had nothing
      // to answer with. Since phase 8 every tab has somewhere else it could go,
      // so the menu opens with those rows and without the file-only ones.
      await mountEditor();
      await open(GRAPH);

      expect(rightClick(tab("Graph"))).toBe(true);
      expect(await screen.findByRole("menu")).toBeTruthy();
      expect(screen.getByText("Split the pane to the right")).toBeTruthy();
      expect(screen.queryByText("File history")).toBeNull();
    });

    // The tab strip derives nothing from "a menu is open" (HistoryPanel does,
    // and phase 3 found what that costs), so what is at risk here is simpler and
    // worse: a menu left on screen with no tab behind it. Kobalte reports no
    // close for a trigger that unmounts, so this asserts the portal goes with
    // its owner rather than that anything was told about it.
    it("takes its menu with it when the tab is closed under it", async () => {
      await mountEditor();
      await open(FILE);
      fireEvent.contextMenu(tab("a.ts"));
      await screen.findByRole("menu");

      fireEvent.click(closeOf("a.ts"));

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(screen.getByText(EMPTY_PANE)).toBeTruthy();
    });

    // The strip renders every tab twice, once to measure and once to show. Only
    // the second one can be right-clicked, so only the second one gets a menu:
    // two triggers per tab would double the machinery for a row nobody can reach
    // and leave two of them claiming the same tab.
    it("mounts one menu trigger per tab, not one per copy", async () => {
      await mountEditor();
      await open(FILE);
      await open(GRAPH);

      const strip = document.querySelector('[class*="editorTabs"]')!;
      const ghost = strip.querySelector(".otab-ghost")!;
      const trigger = '[id^="contextmenu-"][id$="-trigger"]';

      // The ghost holds a box per tab and nothing that behaves like one: no
      // menu, no `role="tab"`, and nothing focusable for `aria-hidden-focus` to
      // catch. It is scaffolding for the measurement, and #111 is what made it
      // say so.
      expect(ghost.querySelectorAll("button").length).toBeGreaterThan(0);
      expect(ghost.querySelectorAll('[role="tab"]').length).toBe(0);
      expect(ghost.querySelectorAll("button:not([disabled])").length).toBe(0);
      expect(ghost.querySelectorAll(trigger).length).toBe(0);

      // Every tab a browser would draw holds exactly one menu trigger.
      const shown = [...strip.querySelectorAll('[role="tab"]')];
      expect(shown.length).toBeGreaterThan(0);
      expect(strip.querySelectorAll(trigger).length).toBe(shown.length);
    });
  });
});

describe("what a file tab hands a drag", () => {
  /** jsdom has no DataTransfer, and the payload is the whole claim here. */
  const carry = (el: Element) => {
    const store: Record<string, string> = {};
    const dt = {
      effectAllowed: "none",
      setData: (t: string, v: string) => (store[t] = v),
      getData: (t: string) => store[t] ?? "",
    };
    const e = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: dt });
    el.dispatchEvent(e);
    return store;
  };

  it("carries the path a terminal or the composer inserts, and the tab move beside it", async () => {
    await mountEditor();
    await open(FILE);

    const payload = carry(tab("a.ts"));
    expect(payload["application/x-tori-path"]).toBe(FILE);
    expect(payload["text/plain"]).toBe(FILE);
    expect(payload["application/x-tori-tab"]).toBe(FILE);
  });

  it("hands a view no path at all, and still lets it be moved", async () => {
    await mountEditor();
    await open(GRAPH);

    const payload = carry(tab("Graph"));
    expect(payload["application/x-tori-path"]).toBeUndefined();
    expect(payload["text/plain"]).toBeUndefined();
    expect(payload["application/x-tori-tab"]).toBe(GRAPH);
  });
});
