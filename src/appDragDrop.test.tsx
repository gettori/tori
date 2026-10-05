// Dragging a tab between real panes (plan phase 10 tasks 1 to 4), through the
// shell: the pane hit-tests the pointer, emits the same events the palette and
// the tab menu emit, and App runs the guards. The panels are stubbed to a
// registered descriptor over the real stores, as in appSplits.
//
// jsdom has neither `DragEvent` nor `DataTransfer` and measures every box as
// zero, so both are supplied here: the events are hand-built and the panes,
// strips and tabs are given the rects a real layout would have. What that
// leaves untested is the browser's own drag plumbing, which is what the CDP
// probe (dev/p10-drag-probe.mjs) is for.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, within } from "@solidjs/testing-library";

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
        activate: () => {},
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
import { setOpen, setActiveWorkspace, setActiveByWorkspace } from "./panels/Terminal/terminalTabStore";
import { setTabsByWs, setActiveByWs } from "./panels/Editor/editorTabStore";
import { emitWith, SPLIT_PANE, type SplitPane } from "./utils/events";
import { setPaneLock } from "./layout/tabPlacement";

const REPO = "/space/proj/main";
const { default: App } = await import("./App");
const { storeTwoPanes } = await import("./test/panes");

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

const pane = (n: number) => document.querySelectorAll<HTMLElement>(".work-split .pane")[n];
const panes = () => document.querySelectorAll(".work-split .pane").length;
const tabsIn = (el: HTMLElement) =>
  within(el)
    .queryAllByRole("tab")
    .map((t) => t.textContent ?? "");
const tabEl = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`.otab-list [data-tab-id="${id}"]`)!;
/** The PaneView column inside a leaf: the element that hit-tests a drop, and so
 *  the one an event has to be dispatched inside of. */
const column = (n: number) => pane(n).querySelector<HTMLElement>(".otab-list")!.parentElement!.parentElement!;

type Box = { left: number; top: number; width: number; height: number };
function setRect(el: Element, b: Box) {
  el.getBoundingClientRect = () =>
    ({
      ...b,
      right: b.left + b.width,
      bottom: b.top + b.height,
      x: b.left,
      y: b.top,
      toJSON: () => b,
    }) as DOMRect;
}

/** Lay the panes out side by side, 400 wide each, with 100px tabs in a 40px
 *  strip: the shape the shell would have, which jsdom never computes. */
function layout() {
  const all = document.querySelectorAll<HTMLElement>(".work-split .pane");
  all.forEach((p, i) => {
    const left = i * 400;
    setRect(p, { left, top: 0, width: 400, height: 300 });
    // The shell's `.pane` is the tree's leaf; the column that hit-tests a drop
    // is the PaneView inside it, and it is the one that needs a box.
    const strip = p.querySelector<HTMLElement>(".otab-list")?.parentElement;
    if (strip) {
      setRect(strip, { left, top: 0, width: 400, height: 40 });
      if (strip.parentElement) setRect(strip.parentElement, { left, top: 0, width: 400, height: 300 });
    }
    // On the pill as well as the trigger: the pane measures the pill, which is
    // the box the close button sits inside of.
    p.querySelectorAll<HTMLElement>(".otab-list [data-tab-id]").forEach((t, n) => {
      const box = { left: left + n * 100, top: 0, width: 100, height: 40 };
      setRect(t.closest("[data-tab-pill]") ?? t, box);
      setRect(t, box);
    });
  });
}

class FakeDataTransfer {
  private store: Record<string, string> = {};
  dropEffect = "none";
  effectAllowed = "none";
  setData(type: string, value: string) {
    this.store[type] = value;
  }
  getData(type: string) {
    return this.store[type] ?? "";
  }
  get types() {
    return Object.keys(this.store);
  }
}

function fire(el: Element, type: string, o: { x?: number; y?: number; dt?: FakeDataTransfer } = {}): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    clientX: { value: o.x ?? 0 },
    clientY: { value: o.y ?? 0 },
    dataTransfer: { value: o.dt ?? new FakeDataTransfer() },
    relatedTarget: { value: null },
  });
  el.dispatchEvent(e);
  return e;
}

/** A whole drag: pick a tab up, carry it to a point, drop it there. Answers
 *  the zone the pane lit on the way, so a test asserting a drop changed
 *  nothing can tell a guard apart from a drag that never started. */
function dragTo(from: HTMLElement, onto: HTMLElement, x: number, y: number) {
  const dt = new FakeDataTransfer();
  fire(from, "dragstart", { dt });
  fire(onto, "dragover", { x, y, dt });
  const zone = document.querySelector("[data-drop-zone]")?.getAttribute("data-drop-zone") ?? null;
  fire(onto, "drop", { x, y, dt });
  fire(from, "dragend", { dt });
  return zone;
}

beforeEach(() => {
  localStorage.clear();
  // This suite is about two panes; the shell seeds one (plan phase 12).
  storeTwoPanes(REPO);
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
  setOpen([term("sh:1"), term("sh:2")]);
  setActiveWorkspace(REPO);
  setActiveByWorkspace({ [REPO]: "sh:1" });
  setTabsByWs({ [REPO]: [{ path: `${REPO}/a.ts`, name: "a.ts" }] });
  setActiveByWs({ [REPO]: `${REPO}/a.ts` });
});

describe("dropping a tab on another pane", () => {
  it("lands it in that pane's strip, where it was dropped", async () => {
    render(() => <App />);
    layout();
    // sh:2 onto the editor pane's strip, past its one tab: the slot after it.
    dragTo(tabEl(pane(0), "sh:2"), tabEl(pane(1), `${REPO}/a.ts`), 760, 20);

    await waitFor(() => expect(tabsIn(pane(1))).toEqual([`${REPO}/a.ts`, "sh:2"]));
    expect(tabsIn(pane(0))).toEqual(["sh:1"]);
  });

  it("lands it before a tab when dropped on that tab's leading half", async () => {
    render(() => <App />);
    layout();
    dragTo(tabEl(pane(0), "sh:2"), tabEl(pane(1), `${REPO}/a.ts`), 410, 20);

    await waitFor(() => expect(tabsIn(pane(1))).toEqual(["sh:2", `${REPO}/a.ts`]));
  });

  it("splits the pane when dropped on its edge, on the side it was dropped", async () => {
    render(() => <App />);
    layout();
    // The editor pane's left edge: a new pane before it, holding the tab.
    dragTo(tabEl(pane(0), "sh:2"), column(1), 410, 150);

    await waitFor(() => expect(tabsIn(pane(1))).toEqual(["sh:2"]));
    expect(panes()).toBe(3);
    expect(tabsIn(pane(2))).toEqual([`${REPO}/a.ts`]);
  });

  it("reorders inside its own strip", async () => {
    render(() => <App />);
    layout();
    dragTo(tabEl(pane(0), "sh:1"), tabEl(pane(0), "sh:2"), 160, 20);

    await waitFor(() => expect(tabsIn(pane(0))).toEqual(["sh:2", "sh:1"]));
  });
});

describe("the overflow menu", () => {
  it("keeps its tabs out of the drag: only the ones that fit are sources", () => {
    render(() => <App />);
    layout();
    const all = [...document.querySelectorAll<HTMLElement>("[data-tab-id]")];
    const sources = all.filter((el) => el.getAttribute("draggable") === "true");
    expect(sources.length).toBeGreaterThan(0);
    // The measuring ghost holds a copy of every tab, overflowed ones included,
    // and none of them is a tab a pointer can reach or pick up.
    expect(sources.every((el) => el.closest(".otab-list"))).toBe(true);
    expect(document.querySelectorAll('.otab-ghost [draggable="true"]').length).toBe(0);
  });

  it("drops beside the last tab that fits, not at the end of the list", async () => {
    render(() => <App />);
    layout();
    // Past every visible tab in the editor pane's strip, which is where the
    // `+N` button sits: the slot after the last one that fits.
    dragTo(tabEl(pane(0), "sh:2"), column(1), 395 + 400, 20);

    await waitFor(() => expect(tabsIn(pane(1))).toEqual([`${REPO}/a.ts`, "sh:2"]));
  });
});

describe("a drop into a locked pane", () => {
  it("says no while the tab is still in the air, and again in words after it", async () => {
    render(() => <App />);
    layout();
    setPaneLock(REPO, "right", "file");

    const dt = new FakeDataTransfer();
    fire(tabEl(pane(0), "sh:2"), "dragstart", { dt });
    fire(column(1), "dragover", { x: 760, y: 20, dt });
    // Refused before the drop ends: the zone is drawn, and drawn as a no.
    expect(pane(1).querySelector("[data-drop-zone]")?.hasAttribute("data-drop-refused")).toBe(true);

    fire(column(1), "drop", { x: 760, y: 20, dt });
    fire(tabEl(pane(0), "sh:2"), "dragend", { dt });

    expect(await screen.findByText(/only takes file tabs/)).toBeTruthy();
    expect(tabsIn(pane(1))).toEqual([`${REPO}/a.ts`]);
  });

  it("still takes an edge drop, which makes a pane of its own", async () => {
    render(() => <App />);
    layout();
    setPaneLock(REPO, "right", "file");
    dragTo(tabEl(pane(0), "sh:2"), column(1), 410, 150);

    await waitFor(() => expect(tabsIn(pane(1))).toEqual(["sh:2"]));
    expect(panes()).toBe(3);
  });
});

describe("a drop the shell cannot honour", () => {
  it("says so, rather than swallowing it", async () => {
    render(() => <App />);
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    emitWith<SplitPane>(SPLIT_PANE, { dir: "row" });
    layout();
    // Four panes already: an edge drop would need a fifth.
    dragTo(tabEl(pane(0), "sh:2"), column(3), 1210, 150);

    expect(await screen.findByText(/4 panes is as many as fit/)).toBeTruthy();
  });
});

describe("the drops that change nothing", () => {
  it("draws no caret and leaves the layout alone in a tab's own slot", () => {
    render(() => <App />);
    layout();
    const before = [tabsIn(pane(0)), tabsIn(pane(1)), panes()];
    // sh:1 is first in its strip; the head of the strip is where it already is.
    const zone = dragTo(tabEl(pane(0), "sh:1"), tabEl(pane(0), "sh:1"), 10, 20);

    expect(zone).toBeNull();
    expect([tabsIn(pane(0)), tabsIn(pane(1)), panes()]).toEqual(before);
  });

  it("draws no half on its own pane's edge while it is the only tab", () => {
    render(() => <App />);
    layout();
    const before = [tabsIn(pane(0)), tabsIn(pane(1)), panes()];
    // The file tab is alone in the editor pane: a split there would empty the
    // pane it left and collapse straight back.
    const zone = dragTo(tabEl(pane(1), `${REPO}/a.ts`), column(1), 780, 150);

    expect(zone).toBeNull();
    expect([tabsIn(pane(0)), tabsIn(pane(1)), panes()]).toEqual(before);
  });

  it("leaves the layout alone once Escape has cancelled the drag", () => {
    render(() => <App />);
    layout();
    const before = [tabsIn(pane(0)), tabsIn(pane(1)), panes()];
    const dt = new FakeDataTransfer();
    fire(tabEl(pane(0), "sh:2"), "dragstart", { dt });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    fire(column(1), "dragover", { x: 760, y: 20, dt });
    fire(column(1), "drop", { x: 760, y: 20, dt });

    expect([tabsIn(pane(0)), tabsIn(pane(1)), panes()]).toEqual(before);
    expect(document.querySelector("[data-drop-zone]")).toBeNull();
  });

  it("draws no zone and takes no drop once the window has lost focus", () => {
    render(() => <App />);
    layout();
    const before = [tabsIn(pane(0)), tabsIn(pane(1)), panes()];
    const dt = new FakeDataTransfer();
    fire(tabEl(pane(0), "sh:2"), "dragstart", { dt });
    window.dispatchEvent(new Event("blur"));
    fire(column(1), "dragover", { x: 410, y: 150, dt });
    fire(column(1), "drop", { x: 410, y: 150, dt });

    expect([tabsIn(pane(0)), tabsIn(pane(1)), panes()]).toEqual(before);
    expect(document.querySelector("[data-drop-zone]")).toBeNull();
  });
});

describe("where the caret lands", () => {
  it("draws it past the close button, at the tab's own edge", () => {
    // The close is a sibling of the trigger `data-tab-id` sits on, so a caret
    // measured off the trigger lands between the label and the x.
    render(() => <App />);
    layout();
    setRect(tabEl(pane(0), "sh:1"), { left: 0, top: 0, width: 70, height: 40 });
    const carried = tabEl(pane(1), `${REPO}/a.ts`);
    const dt = new FakeDataTransfer();
    fire(carried, "dragstart", { dt });
    fire(column(0), "dragover", { x: 60, y: 20, dt });

    const caret = pane(0).querySelector<HTMLElement>("[data-drop-zone='strip']")!;
    expect(caret.style.left).toBe("100px");
    fire(carried, "dragend", { dt });
  });
});

describe("what the stage still owns", () => {
  it("yields the center to a surface that takes the drop itself", () => {
    // What a terminal does with a file tab dropped on it: read the path and
    // insert it. The pane must not also move the tab out from under it.
    render(() => <App />);
    layout();
    const stage = pane(1).querySelector<HTMLElement>("[class*='stage']")!;
    stage.addEventListener("drop", (e) => e.preventDefault());
    const before = [tabsIn(pane(0)), tabsIn(pane(1))];
    dragTo(tabEl(pane(0), "sh:2"), stage, 600, 150);

    expect([tabsIn(pane(0)), tabsIn(pane(1))]).toEqual(before);
  });

  it("takes the center itself when nothing on the stage wanted it", async () => {
    render(() => <App />);
    layout();
    dragTo(tabEl(pane(0), "sh:2"), pane(1).querySelector<HTMLElement>("[class*='stage']")!, 600, 150);

    await waitFor(() => expect(tabsIn(pane(1))).toEqual([`${REPO}/a.ts`, "sh:2"]));
  });

  it("shows the zone it would drop into while the pointer is over it", () => {
    render(() => <App />);
    layout();
    const dt = new FakeDataTransfer();
    fire(tabEl(pane(0), "sh:2"), "dragstart", { dt });
    fire(column(1), "dragover", { x: 410, y: 150, dt });
    expect(pane(1).querySelector("[data-drop-zone]")?.getAttribute("data-drop-zone")).toBe("edge-left");

    fire(column(1), "dragover", { x: 500, y: 20, dt });
    expect(pane(1).querySelector("[data-drop-zone]")?.getAttribute("data-drop-zone")).toBe("strip");
    fire(tabEl(pane(0), "sh:2"), "dragend", { dt });
    expect(document.querySelector("[data-drop-zone]")).toBeNull();
  });
});
