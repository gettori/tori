// The single-pane default (plan phase 12). A workspace starts as one pane whose
// strip holds every kind together; a split is something the user asks for and
// keeps; and the editor chrome is workspace chrome, so it stays put through
// every split and move rather than riding the pane that holds files.
//
// Same stubbed panels as appSplits: registered descriptors over the real
// stores, so the strips are the real ones and the shell is the subject.
import { describe, it, expect, vi, afterEach, beforeEach } from "vite-plus/test";
import { cleanup, render, waitFor, within } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("./panels/LeftSidebar/LeftSidebar", () => ({ default: () => <div /> }));
vi.mock("./panels/Settings/Settings", () => ({ default: () => <div /> }));
vi.mock("./components/Toolbar/Toolbar", () => ({ default: () => <div /> }));
vi.mock("./components/UpdatePill/UpdatePill", () => ({ default: () => <div /> }));
vi.mock("./components/Omnibox/Omnibox", () => ({ default: () => <div /> }));

vi.mock("./panels/Terminal/Terminal", async () => {
  const { registerKind } = await import("./tabs/registry");
  const store = await import("./panels/Terminal/terminalTabStore");
  const { unifiedTabs } = await import("./tabs/unifiedTabs");
  return {
    default: () => {
      for (const kind of ["shell", "agent", "command", "chat", "task"] as const) {
        registerKind(kind, {
          icon: () => undefined,
          title: (u) => u.id,
          tooltip: (u) => u.id,
          renderMenuItem: (u) => <span>{u.id}</span>,
          activate: (u) => store.focusTab(u.workspace, u.id),
          close: () => {},
          stripItems: () => unifiedTabs().filter((u) => u.kind !== "file" && u.workspace === store.activeWorkspace()),
          stripActiveId: store.visibleId,
          stripReorder: () => {},
          hostIds: () => store.open().map((t) => t.id),
        });
      }
      return null;
    },
  };
});
vi.mock("./panels/Editor/Editor", async () => {
  const { registerKind } = await import("./tabs/registry");
  const store = await import("./panels/Editor/editorTabStore");
  const { unifiedTabs } = await import("./tabs/unifiedTabs");
  return {
    default: () => {
      registerKind("file", {
        icon: () => undefined,
        title: (u) => u.id,
        tooltip: (u) => u.id,
        renderMenuItem: (u) => <span>{u.id}</span>,
        activate: (u) => store.setActiveByWs({ ...store.activeByWs(), [REPO]: u.id }),
        close: () => {},
        stripItems: () => unifiedTabs().filter((u) => u.kind === "file"),
        stripActiveId: () => store.activeByWs()[REPO] ?? null,
        stripReorder: () => {},
        hostIds: (paneId, tabs) => (paneId === null ? ["editor-stage"] : tabs.length ? [`editor-stage:${paneId}`] : []),
      });
      return null;
    },
  };
});

import { DEFAULT_SETTINGS } from "./panels/Settings/settingsStore";
import { emit, emitWith, SPLIT_PANE, TOGGLE_SIDEBAR, type SplitPane } from "./utils/events";
import { setOpen, setActiveWorkspace, setActiveByWorkspace } from "./panels/Terminal/terminalTabStore";
import { setTabsByWs, setActiveByWs } from "./panels/Editor/editorTabStore";
import { stageHost } from "./tabs/stageHost";
import { flushDeferredWrites } from "./utils/deferredWrite";

const REPO = "/space/proj/main";
const { default: App } = await import("./App");

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const term = (id: string) => ({
  id,
  title: id,
  cwd: REPO,
  workspace: REPO,
  kind: "shell" as const,
  program: "",
  args: [] as string[],
  profile: null,
});

const panes = () => document.querySelectorAll<HTMLElement>(".work-split .pane");
const tabsIn = (el: HTMLElement) =>
  within(el)
    .queryAllByRole("tab")
    .map((t) => t.textContent ?? "");
const A = `${REPO}/a.ts`;
const chord = (code: string) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { metaKey: true, altKey: true, code, bubbles: true }));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    "tori.selection.v1",
    JSON.stringify({
      spaceName: "space",
      projectName: "proj",
      projectPath: "/space/proj",
      folderPath: REPO,
      branch: "main",
      projectKind: "plain",
    }),
  );
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") return DEFAULT_SETTINGS;
    if (cmd === "list_user_themes") return { themes: [], errors: [] };
    return null;
  });
  setOpen([term("sh:1")]);
  setActiveWorkspace(REPO);
  setActiveByWorkspace({ [REPO]: "sh:1" });
  setTabsByWs({ [REPO]: [{ path: A, name: "a.ts" }] });
  setActiveByWs({ [REPO]: A });
});

// One shell per test: the layout model is module state, so a second App beside
// the first would leave two of them writing it.
afterEach(cleanup);

describe("a workspace nobody has split", () => {
  it("is one pane, holding every kind in one strip", async () => {
    render(() => <App />);
    await waitFor(() => expect(tabsIn(panes()[0] ?? document.body).sort()).toEqual([A, "sh:1"].sort()));
    expect(panes().length).toBe(1);
  });

  it("keeps the split it is given, across a relaunch", async () => {
    render(() => <App />);
    await waitFor(() => expect(panes().length).toBe(1));
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    expect(panes().length).toBe(2);

    // Remounted the way a relaunch would: the quit lands the deferred store
    // write, then the model is reset from storage.
    flushDeferredWrites();
    cleanup();
    render(() => <App />);
    await waitFor(() => expect(panes().length).toBe(2));
  });

  it("brings a kind to the front instead of hiding the only pane", async () => {
    render(() => <App />);
    await waitFor(() => expect(panes().length).toBe(1));
    const active = () => panes()[0].querySelector('[role="tab"][data-selected]')?.textContent;
    // The terminal tab is what the workspace opened on.
    await waitFor(() => expect(active()).toBe("sh:1"));

    chord("KeyE");
    await waitFor(() => expect(active()).toBe(A));
    expect(panes().length).toBe(1);
    expect(panes()[0].classList.contains("hidden")).toBe(false);
  });
});

describe("a layout stored by an earlier build", () => {
  it("comes back as the single pane, with every tab in it", async () => {
    // The two-pane envelope every workspace used to be seeded with. Rejecting
    // its version is the migration: the workspace re-seeds, and the tabs whose
    // panes are gone fall back to the pin rule.
    localStorage.setItem(
      "tori.panes.v1",
      JSON.stringify({
        [REPO]: {
          version: 1,
          layout: {
            type: "split",
            id: "root",
            dir: "row",
            size: 100,
            children: [
              { type: "pane", id: "left", size: 50, hidden: false },
              { type: "pane", id: "right", size: 50, hidden: false },
            ],
          },
          focusedPaneId: "left",
        },
      }),
    );
    localStorage.setItem(
      "tori.tabpanes.v1",
      JSON.stringify({
        [REPO]: { tabs: { "sh:1": "left", [A]: "right" }, kinds: {}, active: {}, locks: {}, order: {}, seq: 0 },
      }),
    );
    render(() => <App />);

    await waitFor(() => expect(tabsIn(panes()[0] ?? document.body).sort()).toEqual([A, "sh:1"].sort()));
    expect(panes().length).toBe(1);
  });
});

describe("the editor chrome", () => {
  it("sits beside the pane tree, and stays there through a split", async () => {
    render(() => <App />);
    await waitFor(() => expect(panes().length).toBe(1));
    const chrome = stageHost("editor-chrome");
    expect(document.querySelector(".work-split")!.contains(chrome)).toBe(true);
    expect(chrome.closest("[data-pane-id]")).toBeNull();

    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    await waitFor(() => expect(panes().length).toBe(2));
    // The file tree did not travel with the pane the files are in.
    expect(chrome.closest("[data-pane-id]")).toBeNull();
    expect(document.querySelectorAll('[data-stage-host="editor-chrome"]').length).toBe(1);
  });
});

describe("the sidebar's width", () => {
  it("is squeezed by a narrow window without losing the width the user picked", async () => {
    localStorage.setItem(
      "tori.layout.v1",
      JSON.stringify({ sidebar: 900, editor: 640, showSidebar: true, showTerminal: true, showEditor: true }),
    );
    render(() => <App />);

    const aside = await waitFor(() => document.querySelector<HTMLElement>(".pane.sidebar")!);
    const drawn = parseFloat(aside.style.width);
    expect(drawn).toBeLessThan(900);
    expect(drawn).toBeGreaterThanOrEqual(180);

    // Anything that persists the layout has to write the choice, not the squeeze,
    // so widening the window later hands the 900 back.
    emit(TOGGLE_SIDEBAR);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("tori.layout.v1")!).sidebar).toBe(900));
  });
});
