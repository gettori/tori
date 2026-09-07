// The third sidebar mode. Selecting it is selecting the Shells workspace, since
// there is one of it and no memory to restore. The list mirrors what is running;
// a command tab never persists, so a stored Shells mode restores to Spaces.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import type { Selection } from "./LeftSidebar";
import type { LiveTab } from "../../utils/events";

const WORK = "/root/work/proj";
const MAIN = `${WORK}/main`;

const config = {
  path: "/cfg/sway.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      external: false,
      projects: [
        {
          name: "proj",
          path: WORK,
          kind: "repo",
          branchUnits: [
            { label: "main", folderPath: MAIN, branch: "main", kind: "worktree", isCurrent: false },
          ],
        },
      ],
    },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_features") return Promise.resolve([]);
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    isFocused: () => Promise.resolve(true),
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));

const { default: LeftSidebar } = await import("./LeftSidebar");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { emit, emitWith, onWith, TOGGLE_SIDEBAR_MODE, REVEAL_SHELLS, TERMINAL_TAB_FOCUSED, FOCUS_SESSION_TAB } =
  await import("../../utils/events");
const { reportCommandExit, resetCommandStatus } = await import("../Terminal/commandStatus");
const { SHELLS_KEY } = await import("../../utils/features");

const cmd = (id: string, title: string, over: Partial<LiveTab> = {}): LiveTab => ({
  id,
  workspace: SHELLS_KEY,
  kind: "command",
  cwd: MAIN,
  title,
  state: "live",
  ...over,
});

/** A shell the user opened with the strip's `+`: same workspace, no verdict. */
const shell = (id: string, title: string, over: Partial<LiveTab> = {}): LiveTab =>
  cmd(id, title, { kind: "shell", cwd: "/home/me", ...over });

function mount(liveTabs: LiveTab[] = []) {
  const [sel, setSel] = createSignal<Selection | null>(null);
  const onSelect = vi.fn((s: Selection | null) => setSel(s));
  const r = render(() => <LeftSidebar selected={sel()} onSelect={onSelect} liveTabs={liveTabs} />);
  return { sel, onSelect, ...r };
}

const segment = (name: string | RegExp) => screen.getByRole("button", { name });
const pressed = (name: string | RegExp) => segment(name).getAttribute("aria-pressed") === "true";
const rows = () => [...document.querySelectorAll("[data-shells-list] li")];

beforeEach(() => {
  resetSessionStoreForTests();
  resetSessionActivityForTests();
  resetCommandStatus();
  Element.prototype.scrollIntoView = () => {};
  localStorage.clear();
  localStorage.setItem("sway.active-space.v1", "work");
});

describe("the Shells mode", () => {
  it("is a third segment that selects the Shells workspace", async () => {
    const { sel, onSelect, container } = mount([cmd("job:1", "Sign in")]);
    await screen.findByText("proj");
    expect(pressed("work")).toBe(true);

    fireEvent.click(segment(/Shells/));
    await waitFor(() => expect(pressed(/Shells/)).toBe(true));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(sel()?.kind).toBe("shells");
    // The tree is the Spaces mode's, so it goes with the mode.
    expect(screen.queryByText("proj")).toBeNull();
    await expectNoAxeViolations(container);

    // Already there: a second reveal hands nobody a new selection to react to.
    emit(REVEAL_SHELLS);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  // The three views live in one strip now, and the strip is read left to right:
  // the spaces first, then the two that are not a space. Tab order follows the
  // DOM, so drawing them out of order would also traverse them out of order.
  it("draws the spaces first and the two mode tiles after them", async () => {
    mount();
    await screen.findByText("proj");
    const order = [segment("work"), segment("Features"), segment(/Shells/)];
    for (const [i, el] of order.slice(1).entries()) {
      expect(
        order[i]!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // A layout, not a selection.
    expect(pressed("work")).toBe(true);
  });

  it("restores to Spaces when a stored Shells mode has nothing running", async () => {
    localStorage.setItem("sway.sidebar-mode.v1", "shells");
    mount();
    await screen.findByText("proj");
    expect(pressed("work")).toBe(true);
    expect(pressed("Shells")).toBe(false);
  });

  it("stays in Shells across a remount while something is running", async () => {
    localStorage.setItem("sway.sidebar-mode.v1", "shells");
    mount([cmd("job:1", "Sign in")]);
    await waitFor(() => expect(pressed(/Shells/)).toBe(true));
  });

  it("steps spaces, features, shells, spaces on the palette's toggle", async () => {
    mount();
    await screen.findByText("proj");
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(pressed("Features")).toBe(true));
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(pressed("Shells")).toBe(true));
    emit(TOGGLE_SIDEBAR_MODE);
    await waitFor(() => expect(pressed("work")).toBe(true));
  });

  it("takes the window on REVEAL_SHELLS, for a panel that cannot reach onSelect", async () => {
    const { sel } = mount();
    await screen.findByText("proj");
    emit(REVEAL_SHELLS);
    await waitFor(() => expect(pressed("Shells")).toBe(true));
    expect(sel()?.kind).toBe("shells");
  });

  it("lists what is running with its verdict, and badges the segment with the count", async () => {
    mount([cmd("job:1", "Sign in"), cmd("job:2", "Install claude")]);
    await screen.findByText("proj");
    // A verdict before the mode is opened: the row reads the store, it does not
    // record its own state.
    reportCommandExit("job:2", 1);

    fireEvent.click(segment(/Shells/));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().map((r) => r.querySelector('[class*="shellsName"]')?.textContent)).toEqual([
      "Sign in",
      "Install claude",
    ]);
    expect(rows().map((r) => r.querySelector("[data-state]")?.getAttribute("data-state"))).toEqual([
      "running",
      "failed",
    ]);

    const badge = document.querySelector('[class*="tileCount"]');
    expect(badge?.textContent).toBe("2");
  });

  it("says so when nothing is running, and filters the rows it has", async () => {
    const { container } = mount([cmd("job:1", "Sign in")]);
    await screen.findByText("proj");
    fireEvent.click(segment(/Shells/));
    await waitFor(() => expect(rows()).toHaveLength(1));

    fireEvent.click(screen.getByLabelText("Filter"));
    const field = await screen.findByLabelText("Filter shells");
    fireEvent.input(field, { target: { value: "install" } });
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(container.textContent).toContain("Nothing matches the filter.");
  });

  // What an auto-close that empties the group asks for: the terminal names the
  // folder its last command came from, and the sidebar decides.
  it("comes back out to a branch unit the terminal points at", async () => {
    const { sel } = mount();
    await screen.findByText("proj");
    fireEvent.click(segment("Shells"));
    await waitFor(() => expect(sel()?.kind).toBe("shells"));

    emitWith<{ folderPath: string }>(TERMINAL_TAB_FOCUSED, { folderPath: MAIN });
    await waitFor(() => expect(pressed("work")).toBe(true));
    expect(sel()?.folderPath).toBe(MAIN);
  });

  it("stays where it is when that folder is gone", async () => {
    const { sel } = mount();
    await screen.findByText("proj");
    fireEvent.click(segment("Shells"));
    await waitFor(() => expect(sel()?.kind).toBe("shells"));

    emitWith<{ folderPath: string }>(TERMINAL_TAB_FOCUSED, { folderPath: "/root/work/deleted" });
    await new Promise((r) => setTimeout(r, 0));
    expect(pressed("Shells")).toBe(true);
    expect(sel()?.kind).toBe("shells");
  });

  // A shell you opened yourself lives in the same workspace and belongs in the
  // same list. It has no verdict to report, so it wears no state.
  it("lists a shell you opened beside what Sway is running", async () => {
    mount([cmd("job:1", "Sign in"), shell("sh:1", "Shell")]);
    await screen.findByText("proj");
    fireEvent.click(segment(/Shells/));
    await waitFor(() => expect(rows()).toHaveLength(2));

    expect(rows().map((r) => r.querySelector('[class*="shellsName"]')?.textContent)).toEqual([
      "Sign in",
      "Shell",
    ]);
    expect(rows().map((r) => !!r.querySelector("[data-state]"))).toEqual([true, false]);
  });

  it("marks the row whose tab is on screen, and only that one", async () => {
    const { container } = mount([cmd("job:1", "Sign in"), cmd("job:2", "Install claude", { active: true })]);
    await screen.findByText("proj");
    fireEvent.click(segment(/Shells/));
    await waitFor(() => expect(rows()).toHaveLength(2));

    const current = () =>
      rows().map((r) => r.querySelector("button")?.getAttribute("aria-current") ?? null);
    expect(current()).toEqual([null, "true"]);
    await expectNoAxeViolations(container);
  });

  // The strip is the other way in, and it is off screen while the sidebar is
  // what you are looking at, so a row has to be able to move the window itself.
  it("focuses a tab when its row is clicked", async () => {
    const focused: string[] = [];
    const off = onWith<{ tabId: string }>(FOCUS_SESSION_TAB, (d) => focused.push(d.tabId));
    mount([cmd("job:1", "Sign in"), cmd("job:2", "Install claude")]);
    await screen.findByText("proj");
    fireEvent.click(segment(/Shells/));
    await waitFor(() => expect(rows()).toHaveLength(2));

    fireEvent.click(rows()[1].querySelector("button")!);
    expect(focused).toEqual(["job:2"]);
    off();
  });

  // The click changes which tab is on screen, which re-emits the live-tab list.
  // A `<For>` over freshly mapped objects would rebuild every row on that and
  // drop the focus the click had just put on one, stranding a keyboard user.
  it("keeps focus on the row it just moved to", async () => {
    const [tabs, setTabs] = createSignal<LiveTab[]>([
      cmd("job:1", "Sign in", { active: true }),
      cmd("job:2", "Install claude"),
    ]);
    const [sel, setSel] = createSignal<Selection | null>(null);
    render(() => (
      <LeftSidebar selected={sel()} onSelect={(x) => setSel(x)} liveTabs={tabs()} />
    ));
    await screen.findByText("proj");
    fireEvent.click(segment(/Shells/));
    await waitFor(() => expect(rows()).toHaveLength(2));

    const btn = rows()[1].querySelector("button")!;
    btn.focus();
    fireEvent.click(btn);
    // What Terminal.tsx does in answer: the focused tab moved, so the surface
    // is re-emitted with fresh objects.
    setTabs([cmd("job:1", "Sign in"), cmd("job:2", "Install claude", { active: true })]);

    await waitFor(() => expect(rows()[1].querySelector("button")!.getAttribute("aria-current")).toBe("true"));
    expect(document.activeElement).toBe(rows()[1].querySelector("button"));
  });

  it("says nothing is running when nothing is", async () => {
    const { container } = mount();
    await screen.findByText("proj");
    fireEvent.click(segment("Shells"));
    await waitFor(() => expect(container.textContent).toContain("Nothing running."));
    expect(rows()).toHaveLength(0);
  });
});
