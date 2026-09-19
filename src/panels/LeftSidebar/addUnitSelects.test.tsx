import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { pointerClick, rightClick } from "../../test/menus";

// Creating a branch-unit is asking to work in it. Both creation paths used to
// stop at "it exists now": the row appeared in the tree and the selection stayed
// on whatever was open before, so the terminal and editor were still pointed at
// the old folder while the user believed they had moved.
//
// The two paths differ in what identifies the new unit. A worktree is a folder,
// and only the backend knows which one it picked (`wave-4` collides, so the
// folder may be a slug), which is why `create_worktree` answers a path. A plain
// repo's branch-units all share the repo folder, so there the branch is the
// identity and the folder tells them apart from nothing.

const WORK = "/root/work";
const CONTAINER = `${WORK}/proj`;
const PLAIN = `${WORK}/repo`;

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  worktrees: ["main"] as string[],
  attached: ["main"] as string[],
  locals: ["main", "old"] as string[],
  current: "main",
}));

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
          branchUnits: bridge.worktrees.map((b) => ({
            label: b,
            folderPath: `${CONTAINER}/${b}`,
            branch: b,
            kind: "worktree",
            isCurrent: false,
          })),
        },
        {
          name: "repo",
          path: PLAIN,
          branchUnits: bridge.attached.map((b) => ({
            label: b,
            folderPath: PLAIN,
            branch: b,
            kind: "plain",
            isCurrent: b === bridge.current,
          })),
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
    if (cmd === "list_branches") {
      const names = args?.path === PLAIN ? bridge.locals : bridge.worktrees;
      return Promise.resolve(names.map((name) => ({ name, current: name === bridge.current })));
    }
    if (cmd === "list_remote_branches") return Promise.resolve([]);
    if (cmd === "create_worktree") {
      const branch = String(args?.branch);
      bridge.worktrees.push(branch);
      return Promise.resolve(`${CONTAINER}/${branch}`);
    }
    if (cmd === "new_branch") {
      const branch = String(args?.branch);
      bridge.locals.push(branch);
      bridge.attached.push(branch);
      return Promise.resolve(null);
    }
    if (cmd === "git_checkout") {
      bridge.current = String(args?.branch);
      return Promise.resolve(null);
    }
    if (cmd === "attach_branch") {
      bridge.attached.push(String(args?.branch));
      return Promise.resolve(null);
    }
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

type Selection = { folderPath?: string; branch?: string; projectKind?: string };
const selections: Selection[] = [];

const last = () => selections[selections.length - 1];
const row = async (label: string) => (await screen.findByText(label)).parentElement!;
const cmds = () => bridge.calls.map((c) => c.cmd);

async function mounted() {
  const r = render(() => (
    <LeftSidebar
      selected={null}
      onSelect={(s: unknown) => selections.push(s as Selection)}
      liveTabs={[]}
    />
  ));
  await waitFor(() => expect(screen.queryByText("proj")).toBeTruthy());
  bridge.calls.length = 0;
  selections.length = 0;
  return r;
}

/** Open a project's context menu and run one of its items. */
async function menu(project: string, item: string) {
  rightClick(await row(project));
  pointerClick(await screen.findByText(item));
}

const filter = () => screen.findByPlaceholderText("Filter branches, or type a new name");

/** Type a name no branch has and add it, which is the create path: the typed
 *  name is the choice while the create row is the only thing answering it. */
async function typeAndAdd(name: string, noun: "worktree" | "branch") {
  fireEvent.input(await filter(), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: `Add ${noun}` }));
}

/** Pick a listed branch and add it. A name that matches a row exactly is not a
 *  new name, so the row has to be pressed before the button means anything. */
async function pickAndAdd(name: string, noun: "worktree" | "branch") {
  fireEvent.input(await filter(), { target: { value: name } });
  fireEvent.click(await screen.findByRole("option", { name }));
  fireEvent.click(screen.getByRole("button", { name: `Add ${noun}` }));
}

describe("creating a branch-unit from the project menu", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.worktrees = ["main"];
    bridge.attached = ["main"];
    bridge.locals = ["main", "old"];
    bridge.current = "main";
    selections.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("moves the selection onto the worktree it just made", async () => {
    await mounted();

    await menu("proj", "Add worktree");
    await typeAndAdd("wave-4", "worktree");

    await waitFor(() => expect(cmds()).toContain("create_worktree"));
    // The folder the backend answered, not one derived from the branch name here:
    // it is the backend that resolves a collision into a different folder.
    await waitFor(() => expect(last()?.folderPath).toBe(`${CONTAINER}/wave-4`));
    expect(last()?.branch).toBe("wave-4");
  });

  it("moves the selection onto the branch it just created and checked out", async () => {
    await mounted();

    await menu("repo", "Add branch");
    await typeAndAdd("feat-2", "branch");

    await waitFor(() => expect(cmds()).toContain("git_checkout"));
    await waitFor(() => expect(last()?.branch).toBe("feat-2"));
    // A plain repo's units share the repo folder, so the branch is what moved.
    expect(last()?.folderPath).toBe(PLAIN);
  });

  it("leaves the selection alone when an existing branch is only attached", async () => {
    // Attaching makes a branch visible; it checks nothing out. Selecting it would
    // raise the working-tree confirm the user never asked for.
    await mounted();

    await menu("repo", "Add branch");
    await pickAndAdd("old", "branch");

    await waitFor(() => expect(cmds()).toContain("attach_branch"));
    expect(cmds()).not.toContain("git_checkout");
    expect(selections).toEqual([]);
  });
});
