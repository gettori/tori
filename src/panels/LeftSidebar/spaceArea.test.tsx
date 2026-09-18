// The space's own surface: a right-click on the tree's empty area is the
// space's menu, and a space with nothing in it says so and offers the way out.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick, rightClick } from "../../test/menus";

const WORK = "/root/work/proj";

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [
        {
          name: "proj",
          path: WORK,
          branchUnits: [
            { label: "main", folderPath: `${WORK}/main`, branch: "main", kind: "worktree", isCurrent: true },
          ],
        },
      ],
    },
    { name: "blank", path: "/root/blank", projects: [] },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    if (cmd === "space_delete_preview") return Promise.resolve({ entries: [], sizeBytes: 0 });
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

const mount = (liveTabs: unknown[] = []) =>
  render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={liveTabs as never} />);
const scroller = (container: HTMLElement) => container.querySelector('[class*="treeScroll"]') as HTMLElement;

describe("the space's empty area", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.sidebar-mode.v1", "spaces");
  });

  it("opens the space's own menu on a right-click", async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());

    expect(rightClick(scroller(container))).toBe(true);
    expect(await screen.findByText("New in “work”")).toBeTruthy();
    expect(screen.getByText("Edit space")).toBeTruthy();
    expect(screen.getByText("Delete space")).toBeTruthy();
  });

  it("leaves a row's own right-click alone", async () => {
    // The rule the two menus share: a row that answers claims the event, and
    // only what nobody claimed reaches the space. Without that, right-clicking
    // a project would open two menus at once.
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());

    rightClick(screen.getByText("proj"));
    expect(await screen.findByText("Change icon")).toBeTruthy();
    expect(screen.queryByText("Delete space")).toBeNull();
  });

  // A clone into this space is killed by the delete exactly as a shell here is
  // (PURGE_UNDER_PATH sweeps by cwd), so the confirm has to count it. Its
  // workspace is `shells:`, which is no path, so only its cwd can place it.
  it("counts a command running into the space it is about to delete", async () => {
    const { container } = mount([
      {
        id: "clone:1",
        workspace: "shells:",
        kind: "command",
        cwd: `${WORK}/fresh`,
        title: "Clone repo",
        state: "live",
      },
    ]);
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());

    rightClick(scroller(container));
    pointerClick(await screen.findByText("Delete space"));
    // The count is a stat panel now: a caps label and a value on two lines, so
    // this reads the box rather than one of them.
    await waitFor(() =>
      expect(screen.getByText("Agents running").parentElement!.textContent).toContain("1"),
    );
  });
});

describe("a space with nothing in it", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "blank");
    localStorage.setItem("tori.sidebar-mode.v1", "spaces");
  });

  it("says so, and offers the way to fill it", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/no projects yet/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // The same dialog the space menu's "New in …" row opens.
    expect(await screen.findByText(/New in .blank./)).toBeTruthy();
  });

  it("still says nothing matched when it is the filter hiding everything", async () => {
    localStorage.setItem("tori.active-space.v1", "work");
    mount();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.input(screen.getByPlaceholderText(/Filter projects/), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("no matches in this space")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});
