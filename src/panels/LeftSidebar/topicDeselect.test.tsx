// Removing a Topic member's worktree from Spaces (#154 phase 1) moves the
// Topic's active root to its next present member; only losing the last one
// clears the selection. A unit selection under the folder clears as before.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";

const CONTAINER = "/root/work/proj";
const WT = `${CONTAINER}/wave-3`;
const OTHER = "/root/work/other/wave-3";

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
          path: CONTAINER,
          branchUnits: [
            { label: "main", folderPath: `${CONTAINER}/main`, branch: "main", kind: "worktree", isCurrent: true },
            { label: "wave-3", folderPath: WT, branch: "wave-3", kind: "worktree", isCurrent: false },
          ],
        },
      ],
    },
  ],
};

const bridge = vi.hoisted(() => ({ calls: [] as { cmd: string; args: Record<string, unknown> }[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "list_sessions" || cmd === "list_project_attempts" || cmd === "sessions_running")
      return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve(null);
    if (cmd === "worktree_status") return Promise.resolve({ dirty: false, unpushed: false, hasRemote: true });
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
const { default: ToastRegion } = await import("../../components/Toasts/Toasts");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { REMOVE_BRANCH_UNIT, emitWith } = await import("../../utils/events");

const topicSel = (roots: string[]) => ({
  kind: "topic" as const,
  topicId: "f1",
  topicName: "Auth",
  roots,
  activeRoot: WT,
  spaceName: "",
  projectName: "Auth",
  projectPath: WT,
  folderPath: WT,
  branch: "feat/auth",
  projectKind: "topic",
});

const cmds = () => bridge.calls.map((c) => c.cmd);

async function removeWave3(selected: unknown) {
  const onSelect = vi.fn();
  const onActiveRoot = vi.fn();
  render(() => (
    <>
      <LeftSidebar selected={selected as never} onSelect={onSelect} onActiveRoot={onActiveRoot} liveTabs={[]} />
      <ToastRegion />
    </>
  ));
  await waitFor(() => expect(screen.queryByText("proj")).toBeTruthy());
  emitWith(REMOVE_BRANCH_UNIT, { projectPath: CONTAINER, branch: "wave-3" });
  const confirm = await screen.findByRole("button", { name: /^Remove worktree$/ });
  pointerClick(confirm);
  await waitFor(() => expect(cmds()).toContain("remove_worktree_and_branch"));
  return { onSelect, onActiveRoot };
}

describe("removing a Topic member's worktree", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    bridge.calls.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
  });

  it("moves the active root to the next present member and keeps the Topic selected", async () => {
    const { onSelect, onActiveRoot } = await removeWave3(topicSel([WT, OTHER]));
    await waitFor(() => expect(onActiveRoot).toHaveBeenCalledWith(OTHER));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clears the selection only when no root remains", async () => {
    const { onSelect, onActiveRoot } = await removeWave3(topicSel([WT]));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    expect(onActiveRoot).not.toHaveBeenCalled();
  });

  it("still clears a unit selection under the removed folder", async () => {
    const unit = {
      kind: "unit",
      spaceName: "work",
      projectName: "proj",
      projectPath: CONTAINER,
      folderPath: WT,
      branch: "wave-3",
      projectKind: "worktree",
    };
    const { onSelect } = await removeWave3(unit);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
  });
});
