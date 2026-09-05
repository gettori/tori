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
const { emit, TOGGLE_SIDEBAR_MODE, REVEAL_SHELLS } = await import("../../utils/events");
const { reportCommandExit, resetCommandStatus } = await import("../Terminal/commandStatus");
const { SHELLS_KEY } = await import("../../utils/features");

const cmd = (id: string, title: string): LiveTab => ({
  id,
  workspace: SHELLS_KEY,
  kind: "command",
  cwd: MAIN,
  title,
  state: "live",
});

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
    expect(pressed("Spaces")).toBe(true);

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

  it("puts all three segments in the arrow order they are drawn in", async () => {
    mount();
    await screen.findByText("proj");
    segment("Spaces").focus();
    fireEvent.keyDown(segment("Spaces"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(segment("Features"));
    fireEvent.keyDown(segment("Features"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(segment("Shells"));
    fireEvent.keyDown(segment("Shells"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(segment("Spaces"));
    // A tour, not a selection.
    expect(pressed("Spaces")).toBe(true);
  });

  it("restores to Spaces when a stored Shells mode has nothing running", async () => {
    localStorage.setItem("sway.sidebar-mode.v1", "shells");
    mount();
    await screen.findByText("proj");
    expect(pressed("Spaces")).toBe(true);
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
    await waitFor(() => expect(pressed("Spaces")).toBe(true));
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

    const badge = document.querySelector('[class*="modeCount"]');
    expect(badge?.textContent).toBe("2");
  });

  it("says so when nothing is running, and filters the rows it has", async () => {
    const { container } = mount([cmd("job:1", "Sign in")]);
    await screen.findByText("proj");
    fireEvent.click(segment(/Shells/));
    await waitFor(() => expect(rows()).toHaveLength(1));

    fireEvent.click(screen.getByLabelText("Filter"));
    const field = await screen.findByLabelText("Filter commands");
    fireEvent.input(field, { target: { value: "install" } });
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(container.textContent).toContain("No command matches the filter.");
  });

  it("says nothing is running when nothing is", async () => {
    const { container } = mount();
    await screen.findByText("proj");
    fireEvent.click(segment("Shells"));
    await waitFor(() => expect(container.textContent).toContain("Nothing running."));
    expect(rows()).toHaveLength(0);
  });
});
