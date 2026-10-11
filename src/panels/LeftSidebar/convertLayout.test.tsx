import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick, rightClick } from "../../test/menus";

// Converting a plain clone from its project menu: the entry is only there for a
// plain repo, the dialog refuses while anything in the app still holds the
// checkout, and a conversion moves the user's editor state and selection along
// with the files instead of leaving them on a folder that is now the container.

const WORK = "/root/work";
const PLAIN = `${WORK}/repo`;
const CONTAINER = `${WORK}/proj`;

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  repoKind: "plain" as "plain" | "worktree" | "converting",
  stash: {} as Record<string, unknown>,
}));

const repoUnits = () =>
  bridge.repoKind === "worktree"
    ? [{ label: "main", folderPath: `${PLAIN}/main`, branch: "main", kind: "worktree", isCurrent: false }]
    : [
        {
          label: bridge.repoKind === "plain" ? "main" : "repo",
          folderPath: PLAIN,
          branch: bridge.repoKind === "plain" ? "main" : null,
          kind: bridge.repoKind,
          isCurrent: true,
        },
      ];

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
        { name: "repo", path: PLAIN, branchUnits: repoUnits() },
      ],
    },
  ],
});

const preview = {
  branch: "main",
  leaf: "main",
  target: `${PLAIN}/main`,
  tori: [{ from: `${PLAIN}/.tori/worktrees/t`, to: `${PLAIN}/t` }],
  nested: [],
  outside: [],
  topics: [],
};

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config());
    if (cmd === "conversion_preview") return Promise.resolve(preview);
    if (cmd === "convert_to_worktree_layout") {
      bridge.repoKind = "worktree";
      return Promise.resolve(preview);
    }
    if (cmd === "undo_conversion") {
      bridge.repoKind = "plain";
      return Promise.resolve(null);
    }
    if (cmd === "hot_exit_load") return Promise.resolve(bridge.stash);
    if (cmd === "list_branches") return Promise.resolve([{ name: "main", current: true }]);
    if (cmd === "list_remote_branches") return Promise.resolve([]);
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
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
const { onWith, WORKSPACE_MOVED } = await import("../../utils/events");
const { publishDirtyPaths } = await import("../../utils/unsavedPaths");
const { clearPendingStash, loadPendingStash } = await import("../../utils/hotExit");

type Selection = { folderPath?: string; branch?: string };
type LiveTab = import("../../utils/events").LiveTab;
const selections: Selection[] = [];
const last = () => selections[selections.length - 1];
const cmds = () => bridge.calls.map((c) => c.cmd);
const row = async (label: string) => (await screen.findByText(label)).parentElement!;
const convertButton = () => screen.getByRole("button", { name: "Convert" }) as HTMLButtonElement;

async function mounted(liveTabs: LiveTab[] = []) {
  render(() => (
    <LeftSidebar selected={null} onSelect={(s: unknown) => selections.push(s as Selection)} liveTabs={liveTabs} />
  ));
  await waitFor(() => expect(screen.queryByText("repo")).toBeTruthy());
  bridge.calls.length = 0;
  selections.length = 0;
}

async function menuItems(project: string) {
  rightClick(await row(project));
  await screen.findByText("Project settings");
  return screen.queryByText("Convert to worktree layout");
}

async function openConvert() {
  rightClick(await row("repo"));
  pointerClick(await screen.findByText("Convert to worktree layout"));
  await waitFor(() => expect(cmds()).toContain("conversion_preview"));
}

describe("converting a plain clone from its project menu", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.repoKind = "plain";
    bridge.stash = {};
    clearPendingStash();
    publishDirtyPaths([]);
    selections.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("is offered on a plain repo and not on a worktree container", async () => {
    await mounted();

    expect(await menuItems("repo")).toBeTruthy();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await menuItems("proj")).toBeNull();
  });

  it("moves the checkout's state along and selects the new worktree", async () => {
    await mounted();
    const moved: unknown[] = [];
    const off = onWith(WORKSPACE_MOVED, (d) => moved.push(d));

    await openConvert();
    await waitFor(() => expect(convertButton().disabled).toBe(false));
    fireEvent.click(convertButton());

    await waitFor(() => expect(cmds()).toContain("convert_to_worktree_layout"));
    await waitFor(() => expect(last()?.folderPath).toBe(`${PLAIN}/main`));
    expect(moved).toEqual([
      {
        moves: [
          { from: PLAIN, to: `${PLAIN}/main` },
          { from: `${PLAIN}/.tori/worktrees/t`, to: `${PLAIN}/t` },
        ],
      },
    ]);
    off();
  });

  it("refuses while an agent runs in the checkout", async () => {
    await mounted([{ id: "t1", workspace: PLAIN, cwd: PLAIN, kind: "agent", state: "live" } as LiveTab]);

    await openConvert();

    expect(await screen.findByText(/1 terminal or agent tab is running in this project/)).toBeTruthy();
    expect(convertButton().disabled).toBe(true);
  });

  it("refuses while a file in the checkout has unsaved changes", async () => {
    await mounted();
    publishDirtyPaths([`${PLAIN}/src/a.ts`]);

    await openConvert();

    expect(await screen.findByText(/1 file has unsaved changes in this project/)).toBeTruthy();
    expect(convertButton().disabled).toBe(true);
  });

  it("counts last quit's stashed work as unsaved too", async () => {
    bridge.stash = { [`${PLAIN}/b.ts`]: { savedText: "", state: {}, savedAt: Date.now() } };
    await loadPendingStash(Date.now());
    await mounted();

    await openConvert();

    expect(await screen.findByText(/1 file has unsaved changes in this project/)).toBeTruthy();
    expect(convertButton().disabled).toBe(true);
  });

  it("offers only Undo on a conversion that stopped partway", async () => {
    bridge.repoKind = "converting";
    await mounted();

    rightClick(await row("repo"));
    expect(await screen.findByText("Undo conversion")).toBeTruthy();
    expect(screen.queryByText("Remove project")).toBeNull();
    pointerClick(screen.getByText("Undo conversion"));

    await waitFor(() => expect(cmds()).toContain("undo_conversion"));
  });
});
