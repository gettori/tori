// The per-click storms (native-speed plan phase 4). A switch between two
// worktrees whose panes are exactly as each left them is a change of what is on
// screen, not of the geometry it is on screen in: it should emit no refit, keep
// the live pane subtree mounted, and re-measure no tab strip. The panels are
// stubbed down to registered descriptors over the real stores, as in appSplits,
// so the shell is the subject.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { installAnimationFrame } from "./test/frames";

const WS_A = "/space/proj/main";
const WS_B = "/space/proj/feature";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

// The sidebar is where a worktree switch comes from, so this stub hands its
// `onSelect` out rather than rendering nothing.
const bridge = vi.hoisted(() => ({ select: (_s: unknown) => {} }));
vi.mock("./panels/LeftSidebar/LeftSidebar", () => ({
  default: (props: { onSelect: (s: unknown) => void }) => {
    bridge.select = props.onSelect;
    return <div />;
  },
}));
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
      registerKind("shell", {
        icon: () => undefined,
        title: (u) => u.id,
        tooltip: (u) => u.id,
        renderMenuItem: (u) => <span>{u.id}</span>,
        activate: (u) => store.focusTab(u.workspace, u.id),
        close: () => {},
        stripItems: () =>
          unifiedTabs().filter((u) => u.kind === "shell" && u.workspace === store.activeWorkspace()),
        stripActiveId: store.visibleId,
        stripReorder: () => {},
        hostIds: () => store.open().map((t) => t.id),
      });
      return null;
    },
  };
});
vi.mock("./panels/Editor/Editor", () => ({ default: () => null }));

import { DEFAULT_SETTINGS } from "./panels/Settings/settingsStore";
import {
  on as onEvent,
  emit,
  emitWith,
  REFIT_PANES,
  TOGGLE_SIDEBAR,
  SPLIT_PANE,
  type SplitPane,
} from "./utils/events";
import {
  setOpen,
  setActiveWorkspace,
  setActiveByWorkspace,
  open,
} from "./panels/Terminal/terminalTabStore";
import { __measuresForTests } from "./components/OverflowTabBar";
import { setPaneActive } from "./layout/tabPlacement";

const { default: App } = await import("./App");
const { storeTwoPanes } = await import("./test/panes");

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

installAnimationFrame();

const selectionFor = (ws: string) => ({
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: ws,
  branch: ws === WS_A ? "main" : "feature",
  projectKind: "plain",
});

const term = (id: string, ws: string) => ({
  id,
  title: id,
  cwd: ws,
  workspace: ws,
  kind: "shell" as const,
  program: "",
  args: [] as string[],
  profile: null,
});

const panes = () => [...document.querySelectorAll<HTMLElement>(".work-split .pane")];
const splitEl = () => document.querySelector<HTMLElement>(".work-split .pane-split");

/** Switch the shell to a worktree, the two ways the app does it at once: the
 *  sidebar's selection, and the terminal store's notion of what is on screen. */
function switchTo(ws: string) {
  bridge.select(selectionFor(ws));
  setActiveWorkspace(ws);
}

let refits = 0;
let offRefit: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  // Two worktrees, split exactly the same way: the case a switch should be able
  // to render without rebuilding anything.
  storeTwoPanes(WS_A);
  const stored = JSON.parse(localStorage.getItem("tori.panes.v1")!);
  localStorage.setItem(
    "tori.panes.v1",
    JSON.stringify({ ...stored, [WS_B]: JSON.parse(JSON.stringify(stored[WS_A])) }),
  );
  localStorage.setItem("tori.selection.v1", JSON.stringify(selectionFor(WS_A)));
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_settings") return DEFAULT_SETTINGS;
    if (cmd === "list_user_themes") return { themes: [], errors: [] };
    return null;
  });
  setOpen([term("sh:1", WS_A), term("sh:2", WS_A), term("sh:3", WS_B)]);
  setActiveWorkspace(WS_A);
  setActiveByWorkspace({ [WS_A]: "sh:1", [WS_B]: "sh:3" });
  refits = 0;
  offRefit = onEvent(REFIT_PANES, () => refits++);
});

afterEach(() => {
  offRefit?.();
  cleanup();
});

describe("a warm switch between two same-shape worktrees", () => {
  it("emits no refit", () => {
    render(() => <App />);
    refits = 0;
    switchTo(WS_B);
    switchTo(WS_A);
    switchTo(WS_B);
    expect(refits).toBe(0);
  });

  it("keeps the live pane subtree mounted rather than reparenting it", () => {
    render(() => <App />);
    const before = { split: splitEl(), panes: panes() };
    expect(before.panes.length).toBe(2);
    switchTo(WS_B);
    expect(splitEl()).toBe(before.split);
    expect(panes()).toEqual(before.panes);
    switchTo(WS_A);
    expect(panes()).toEqual(before.panes);
  });

});

describe("what still refits", () => {
  it("a pane revealed inside the workspace", () => {
    render(() => <App />);
    emit(TOGGLE_SIDEBAR);
    refits = 0;
    emit(TOGGLE_SIDEBAR);
    expect(refits).toBe(1);
  });

  // More than one: the pane the split made adopts a surface, and adoption emits
  // its own refit (PaneView). Both are edits, which is the point.
  it("a structural edit to the workspace's own tree", () => {
    render(() => <App />);
    refits = 0;
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    expect(refits).toBeGreaterThan(0);
  });
});

// A worktree switch is not in here: the strips genuinely show different tabs
// either side of one, so re-measuring is the right answer. What was wrong was a
// click, which changes no strip's contents and re-measured every one of them.
describe("a tab strip", () => {
  it("re-measures when its own id set changes, not when a click reshuffles panes", () => {
    render(() => <App />);
    const before = __measuresForTests();
    // What a strip click runs (PaneView's `onActivate`), which rewrites the
    // placement store and so hands every pane in the window a fresh item list.
    setPaneActive(WS_A, "left", "sh:2");
    expect(__measuresForTests()).toBe(before);
    setOpen([...open(), term("sh:4", WS_A)]);
    expect(__measuresForTests()).toBeGreaterThan(before);
  });
});
