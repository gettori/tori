import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick, rightClick } from "../../test/menus";

const WORK = "/root/work";
const PLAIN = `${WORK}/repo`;
const CONTAINER = `${WORK}/proj`;
const RESTORED = `${PLAIN}/.tori/worktrees/feat-restored`;

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  restored: false,
}));

const rescue = {
  id: "1762400000000-aaaa1111",
  branch: "feat",
  worktree: `${PLAIN}/.tori/worktrees/feat`,
  deletedAt: 1762400000000,
  operation: "rebase 1/1",
  files: ["a.txt"],
  commits: [],
  skipped: [],
};

const config = () => ({
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: WORK,
      projects: [
        {
          name: "proj",
          path: CONTAINER,
          branchUnits: [
            { label: "main", folderPath: `${CONTAINER}/main`, branch: "main", kind: "worktree", isCurrent: false },
          ],
        },
        {
          name: "repo",
          path: PLAIN,
          branchUnits: [
            { label: "main", folderPath: PLAIN, branch: "main", kind: "plain", isCurrent: true },
            ...(bridge.restored
              ? [
                  {
                    label: "feat-restored",
                    folderPath: RESTORED,
                    branch: "feat-restored",
                    kind: "worktree",
                    isCurrent: false,
                  },
                ]
              : []),
          ],
        },
      ],
    },
  ],
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config());
    if (cmd === "rescue_counts") return Promise.resolve(bridge.restored ? {} : { [PLAIN]: 1 });
    if (cmd === "rescue_list") return Promise.resolve([rescue]);
    if (cmd === "rescue_restore") {
      bridge.restored = true;
      return Promise.resolve(RESTORED);
    }
    if (cmd === "hot_exit_load") return Promise.resolve({});
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "sessions_running") return Promise.resolve([]);
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

type Selection = { folderPath?: string };
const selections: Selection[] = [];
const row = async (label: string) => (await screen.findByText(label)).parentElement!;
const escape = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

async function mounted() {
  render(() => (
    <LeftSidebar selected={null} onSelect={(s: unknown) => selections.push(s as Selection)} liveTabs={[]} />
  ));
  await waitFor(() => expect(bridge.calls.map((c) => c.cmd)).toContain("rescue_counts"));
}

async function menuEntry(project: string) {
  rightClick(await row(project));
  await screen.findByText("Project settings");
  return screen.queryByText("Restore deleted worktree");
}

describe("restoring a deleted worktree from the project menu", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.restored = false;
    selections.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("is offered on a plain repo that has a kept copy and not on a project without one", async () => {
    await mounted();
    await waitFor(async () => expect(await menuEntry("repo")).toBeTruthy());
    escape();
    expect(await menuEntry("proj")).toBeNull();
  });

  it("restores the picked copy and selects the worktree it made", async () => {
    await mounted();
    await waitFor(async () => expect(await menuEntry("repo")).toBeTruthy());
    pointerClick(screen.getByText("Restore deleted worktree"));
    await screen.findByText("rebase 1/1");

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(bridge.calls.find((c) => c.cmd === "rescue_restore")?.args).toEqual({ repo: PLAIN, id: rescue.id }),
    );
    await waitFor(() => expect(selections[selections.length - 1]?.folderPath).toBe(RESTORED));
  });
});
