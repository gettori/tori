// Which space you are in, in words rather than as one lit icon in the rail.
// The header carries the same menu the tile's right-click does, which was the
// only way to it before.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick, rightClick } from "../../test/menus";

const WORK = "/root/work/proj";

const unit = (label: string, folderPath: string) => ({
  label,
  folderPath,
  branch: label,
  kind: "worktree",
  isCurrent: false,
});

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      projects: [{ name: "proj", path: WORK, branchUnits: [unit("main", `${WORK}/main`)] }],
    },
    {
      name: "side",
      path: "/root/side",
      projects: [{ name: "lab", path: "/root/side/lab", branchUnits: [] }],
    },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config);
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

const mount = () => render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
const header = () => document.querySelector('[class*="spaceHeader"]') as HTMLElement | null;
const menuButton = () => screen.getByRole("button", { name: "Actions for work" });

describe("the active space header", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("names the space you are in, above the tree", async () => {
    const { container } = mount();
    await waitFor(() => expect(header()).toBeTruthy());
    expect(header()!.textContent).toContain("work");
    // Above the tree and below the tabs, which is what makes it read as the
    // heading over the projects rather than as one of them.
    const head = container.querySelector('[class*="treeHead"]')!;
    expect(head.compareDocumentPosition(header()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is the space's name and nothing else", async () => {
    mount();
    await waitFor(() => expect(header()).toBeTruthy());
    expect(header()!.textContent!.trim()).toBe("work");
  });

  it("follows the space you switch to", async () => {
    mount();
    await waitFor(() => expect(header()!.textContent).toContain("work"));
    fireEvent.click(screen.getByRole("button", { name: "side" }));
    await waitFor(() => expect(header()!.textContent).toContain("side"));
  });

  it("opens the tile's own menu from the ellipsis", async () => {
    mount();
    await waitFor(() => expect(header()).toBeTruthy());
    pointerClick(menuButton());
    // The same rows `spaceMenu` gives a root-discovered space's tile, each one
    // naming what it acts on.
    expect(await screen.findByText("New in “work”")).toBeTruthy();
    expect(screen.getByText("Space settings\u2026")).toBeTruthy();
    expect(screen.getByText("Delete space")).toBeTruthy();
  });

  it("makes a Topic in this space from its own row in the menu", async () => {
    mount();
    await waitFor(() => expect(header()).toBeTruthy());
    pointerClick(menuButton());
    const row = await screen.findByRole("menuitem", { name: /New Topic/ });
    expect(row.textContent).toContain("Groups worktrees from work's projects");
    pointerClick(row);
    expect(await screen.findByRole("dialog", { name: "New Topic in work" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "proj" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "lab" })).toBeNull();
  });

  it("keeps the menu reachable without a pointer", async () => {
    mount();
    await waitFor(() => expect(header()).toBeTruthy());
    // Hidden by opacity, never by `display`, so it is still a tab stop: an
    // action only a mouse can find is not an action.
    expect(menuButton().tabIndex).not.toBe(-1);
  });

  it("answers a right-click with the same menu", async () => {
    mount();
    await waitFor(() => expect(header()).toBeTruthy());
    expect(rightClick(header()!)).toBe(true);
    expect(await screen.findByText("Delete space")).toBeTruthy();
  });

  it("names Global with its own menu, on the button and on a right-click", async () => {
    mount();
    await waitFor(() => expect(header()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(header()!.textContent!.trim()).toBe("Home"));
    expect(screen.queryByRole("button", { name: "Actions for work" })).toBeNull();
    expect(screen.getByRole("button", { name: "Actions for Home" })).toBeTruthy();
    expect(rightClick(header()!)).toBe(true);
    expect(await screen.findByText("Space settings\u2026")).toBeTruthy();
    expect(screen.queryByText("Delete space")).toBeNull();
  });
});
