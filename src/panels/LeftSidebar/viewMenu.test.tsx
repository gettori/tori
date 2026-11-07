import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { pointerClick } from "../../test/menus";
import { render, screen, waitFor } from "@solidjs/testing-library";

const WORK = "/root/work";

const project = (name: string) => ({
  name,
  path: `${WORK}/${name}`,
  branchUnits: [
    {
      label: `${name}-main`,
      folderPath: `${WORK}/${name}/main`,
      branch: `${name}-main`,
      kind: "worktree",
      isCurrent: true,
    },
  ],
});

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [{ name: "work", path: WORK, projects: [project("alpha"), project("beta")] }],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
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
const { emit, COLLAPSE_PROJECTS, EXPAND_PROJECTS } = await import("../../utils/events");
const { BINDINGS } = await import("../../utils/hotkeys");

const mount = () => render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
const branches = () => ["alpha-main", "beta-main"].filter((b) => screen.queryByText(b));

describe("collapse and expand all", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("opens and shuts every project in the space from the keys' events", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
    expect(branches()).toEqual([]);

    emit(EXPAND_PROJECTS);
    await waitFor(() => expect(branches()).toEqual(["alpha-main", "beta-main"]));

    emit(COLLAPSE_PROJECTS);
    await waitFor(() => expect(branches()).toEqual([]));
  });

  it("does the same from the space menu", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("alpha")).toBeTruthy());
    pointerClick(screen.getByRole("button", { name: "Actions for work" }));
    pointerClick(await screen.findByRole("menuitem", { name: /Expand all/ }));
    await waitFor(() => expect(branches()).toEqual(["alpha-main", "beta-main"]));
  });

  it("lists both keys in the shortcut sheet", () => {
    const ids = BINDINGS.map((b) => b.id);
    expect(ids).toContain("collapse-projects");
    expect(ids).toContain("expand-projects");
  });
});
