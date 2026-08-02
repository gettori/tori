import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";

// "Delete the branch", raised by the Pull Requests panel once it has landed one.
//
// The panel deliberately owns none of this. The guards that matter live in the
// sidebar's own removal dialogs, and there are three of them: uncommitted work
// in the worktree, commits that were never pushed, and agents still running in
// the folder whose PTYs a removal tears down. A second delete path in the PR
// panel would be a second place for all three to be forgotten, so the panel
// names a branch and this is what decides what happens to it.
//
// The unit's *kind* picks the dialog, which is the part a caller outside the
// tree cannot know: removing a worktree removes a folder, and removing a plain
// repo's branch removes no folder at all.

const CONTAINER = "/root/work/proj";
const WT = `${CONTAINER}/wave-3`;
const PLAIN = "/root/work/repo";

const worktreeProject = {
  name: "proj",
  path: CONTAINER,
  external: false,
  branchUnits: [
    { label: "main", folderPath: `${CONTAINER}/main`, branch: "main", kind: "worktree", isCurrent: true },
    { label: "wave-3", folderPath: WT, branch: "wave-3", kind: "worktree", isCurrent: false },
  ],
};

const plainProject = {
  name: "repo",
  path: PLAIN,
  external: false,
  branchUnits: [
    { label: "main", folderPath: PLAIN, branch: "main", kind: "plain", isCurrent: true },
    { label: "feat", folderPath: PLAIN, branch: "feat", kind: "plain", isCurrent: false },
  ],
};

const config = {
  path: "/cfg/sway.toml",
  roots: ["/root"],
  spaces: [
    {
      name: "work",
      path: "/root/work",
      external: false,
      projects: [worktreeProject, plainProject],
    },
  ],
};

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  dirty: false,
  running: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    // One detached agent living in the worktree, which is what makes the
    // live-use guard reach for a probe at all.
    if (cmd === "list_sessions")
      return Promise.resolve(
        args?.folder === WT
          ? [
              {
                id: "s1",
                path: `${WT}/.t/s1.jsonl`,
                cwd: WT,
                branch: "wave-3",
                title: "the agent",
                last_active: 1,
                created_at: 1,
                name: null,
                agent: "claude",
              },
            ]
          : [],
      );
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    if (cmd === "sessions_running") return Promise.resolve(bridge.running);
    if (cmd === "worktree_status")
      return Promise.resolve({ dirty: bridge.dirty, unpushed: false, hasRemote: true });
    if (cmd === "branch_status") return Promise.resolve({ unpushed: false, hasRemote: true });
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
const { REMOVE_BRANCH_UNIT, emitWith } = await import("../../utils/events");

const cmds = () => bridge.calls.map((c) => c.cmd);

async function mounted() {
  const r = render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
  await waitFor(() => expect(screen.queryByText("proj")).toBeTruthy());
  bridge.calls.length = 0;
  return r;
}

const ask = (projectPath: string, branch: string) =>
  emitWith(REMOVE_BRANCH_UNIT, { projectPath, branch });

describe("a branch removal raised from the Pull Requests panel", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    bridge.dirty = false;
    bridge.running = [];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("sway.active-space.v1", "work");
  });

  it("opens the worktree dialog, which is where the dirty guard lives", async () => {
    // A worktree with uncommitted work: the removal has to say so *before* it
    // runs, because the folder and everything in it goes.
    bridge.dirty = true;
    await mounted();

    ask(CONTAINER, "wave-3");

    // The dialog opened, and it asked the questions only it asks.
    await waitFor(() => expect(cmds()).toContain("worktree_status"));
    await waitFor(() => expect(screen.queryByText(/uncommitted/i)).toBeTruthy());
    // Nothing was removed by the mere asking: this is a confirmation, not an act.
    expect(cmds()).not.toContain("remove_worktree");
    expect(cmds()).not.toContain("remove_worktree_and_branch");
    expect(cmds()).not.toContain("delete_remote_branch");
  });

  it("counts the agents running in the folder before offering to remove it", async () => {
    // The live-use guard. Removing a worktree tears down every PTY under it, so
    // the dialog warns rather than pulling the floor out from under an agent
    // mid-turn.
    await mounted();
    ask(CONTAINER, "wave-3");
    await waitFor(() => expect(cmds()).toContain("sessions_running"));
    expect(cmds()).not.toContain("remove_worktree_and_branch");
  });

  it("opens the plain-branch dialog for a branch with no worktree of its own", async () => {
    // The kind is what a caller outside the tree cannot know. A plain repo's
    // branch units share one working directory, so removing one removes no
    // folder, and routing it through the worktree dialog would offer to delete
    // the checkout every other branch is also using.
    await mounted();

    ask(PLAIN, "feat");

    await waitFor(() => expect(cmds()).toContain("branch_status"));
    expect(cmds()).not.toContain("worktree_status");
    expect(cmds()).not.toContain("remove_worktree");
  });

  it("says so rather than guessing when the branch is not in the tree", async () => {
    // A pull request whose head was never checked out here. Silently picking the
    // nearest unit would delete a branch nobody asked about.
    await mounted();

    ask(CONTAINER, "never-here");

    await waitFor(() => expect(screen.queryByText(/never-here/)).toBeTruthy());
    expect(cmds()).not.toContain("worktree_status");
    expect(cmds()).not.toContain("branch_status");
  });
});
