import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";

// "New branch from base", raised by the Pull Requests panel from the one state
// where a review has no branch to propose yet: the pane is standing on the base.
//
// Routed to the sidebar for the same reason the removal is. This owns the
// branch-unit list and the dialog that adds to it, and the project's own kind
// decides which noun that dialog uses: a bare container spawns a worktree, a
// plain repo attaches a branch. A panel cannot know which.

const CONTAINER = "/root/work/proj";
const PLAIN = "/root/work/repo";

const worktreeProject = {
  name: "proj",
  path: CONTAINER,
  branchUnits: [
    { label: "main", folderPath: `${CONTAINER}/main`, branch: "main", kind: "worktree", isCurrent: true },
  ],
};

const plainProject = {
  name: "repo",
  path: PLAIN,
  branchUnits: [
    { label: "main", folderPath: PLAIN, branch: "main", kind: "plain", isCurrent: true },
  ],
};

const config = {
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [{ name: "work", path: "/root/work", projects: [worktreeProject, plainProject] }],
};

const bridge = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_branches")
      return Promise.resolve([{ name: "main" }, { name: "wave-3" }]);
    if (cmd === "list_remote_branches") return Promise.resolve(["release"]);
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
const { default: ToastRegion } = await import("../../components/Toasts/Toasts");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { ADD_BRANCH_UNIT, emitWith } = await import("../../utils/events");

const cmds = () => bridge.calls.map((c) => c.cmd);
const filter = () => screen.getByPlaceholderText(/Filter branches/) as HTMLInputElement;

async function mounted() {
  const r = render(() => (
    <>
      <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />
      <ToastRegion />
    </>
  ));
  await waitFor(() => expect(screen.queryByText("proj")).toBeTruthy());
  bridge.calls.length = 0;
  return r;
}

describe("an add-branch raised from the Pull Requests panel", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("opens the worktree dialog on the base it was given", async () => {
    await mounted();

    emitWith(ADD_BRANCH_UNIT, { projectPath: CONTAINER, base: "main" });

    await waitFor(() => expect(screen.queryByText(/Add worktree in/)).toBeTruthy());
    await waitFor(() => expect(cmds()).toContain("list_branches"));
    expect(filter().value).toBe("main");
    // Picked, not merely filtered to: the row the caller named is the one the
    // action bar is about.
    // Picked, not merely filtered to. The list is closed until someone opens
    // it, so the pick is read where it is visible either way: the action bar's
    // path hint exists only once there is a branch for it to be about.
    // Picked, not merely filtered to. The list stays closed until someone
    // opens it, so the pick is read where it shows either way: the action bar's
    // path hint exists only once there is a branch for it to be about.
    await waitFor(() => expect(screen.queryByText(`${CONTAINER}/main`)).toBeTruthy());
    // Asking is not adding: the dialog is a question and nothing was created.
    expect(cmds()).not.toContain("create_worktree");
    expect(cmds()).not.toContain("new_branch");
  });

  it("opens the plain-branch dialog for a repo with no worktrees", async () => {
    // The noun is the project's, not the caller's: attaching a branch to a plain
    // repo makes no folder, and the worktree dialog would promise one.
    await mounted();

    emitWith(ADD_BRANCH_UNIT, { projectPath: PLAIN, base: "main" });

    await waitFor(() => expect(screen.queryByText(/Add branch in/)).toBeTruthy());
    expect(screen.queryByText(/Add worktree in/)).toBeNull();
  });

  it("refuses to add the branch the tree already has open", async () => {
    // The base usually is open: it is where the pane was standing when it
    // asked. Parking it is how the dialog says where you are; confirming it
    // would re-add a unit the sidebar is already drawing.
    await mounted();

    emitWith(ADD_BRANCH_UNIT, { projectPath: CONTAINER, base: "main" });

    await waitFor(() => expect(screen.queryByText(/Add worktree in/)).toBeTruthy());
    const primary = screen.getByText("Add worktree").closest("button") as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
  });

  it("says so rather than guessing when the project is not open here", async () => {
    await mounted();

    emitWith(ADD_BRANCH_UNIT, { projectPath: "/elsewhere/repo", base: "main" });

    await waitFor(() => expect(screen.queryByText(/\/elsewhere\/repo/)).toBeTruthy());
    expect(cmds()).not.toContain("list_branches");
  });
});
