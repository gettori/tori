import { expect, it, vi } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen } from "../../test/harness";
import { renderCost, renderDrift, rerunBudget, rowsChurned } from "../../test/perfCounters";
import type { BranchSync } from "../../utils/gitActions";

vi.mock("solid-js", async (original) => {
  const { countingSolid } = await import("../../test/perfCounters");
  return countingSolid(await original<typeof import("solid-js")>());
});

const WORK = "/root/work";
const REPO = `${WORK}/repo`;
const worktree = (label: string) => ({
  label,
  folderPath: `${REPO}/${label}`,
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
      path: WORK,
      projects: [{ name: "repo", path: REPO, branchUnits: [worktree("alpha"), worktree("beta")] }],
    },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: (cmd: string) => {
    if (cmd === "get_config") return Promise.resolve(config);
    if (cmd === "git_branch_sync_many") return Promise.resolve({});
    if (cmd === "list_sessions" || cmd === "list_topics" || cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
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
type Selection = import("./LeftSidebar").Selection;
const { adoptSync } = await import("../../utils/branchSync");

const ahead: BranchSync = {
  detached: false,
  dirty: false,
  head_committed_at: 1_700_000_000,
  upstream: { ahead: 2, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false },
  base: null,
} as BranchSync;

it("holds the render budget for one branch status change", async () => {
  Element.prototype.scrollIntoView = () => {};
  localStorage.clear();
  localStorage.setItem("tori.active-space.v1", "work");
  localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/repo"]));
  const { container } = render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
  await screen.findByText("beta");

  const { cost, artifact, lists } = await renderCost(container, () => adoptSync(`${REPO}/alpha`, "alpha", ahead));

  expect(cost.mutations).toBeGreaterThan(0);
  const worktreeRows = lists.filter((list) => (list.first as { folderPath?: string } | undefined)?.folderPath);
  expect(worktreeRows.length).toBeGreaterThan(0);
  expect(rowsChurned(worktreeRows)).toEqual([]);
  expect(artifact).toStayWithinRerunBudget(rerunBudget("sidebar.branch_status"));
  expect(renderDrift("sidebar.branch_status", cost), JSON.stringify(cost)).toEqual([]);
});

it("holds the render budget for one selection change", async () => {
  Element.prototype.scrollIntoView = () => {};
  localStorage.clear();
  localStorage.setItem("tori.active-space.v1", "work");
  localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/repo"]));
  const unit = (branch: string): Selection => ({
    spaceName: "work",
    projectName: "repo",
    projectPath: REPO,
    folderPath: `${REPO}/${branch}`,
    branch,
    projectKind: "worktree",
    profile: null,
  });
  const [selected, setSelected] = createSignal<Selection>(unit("alpha"));
  const { container } = render(() => <LeftSidebar selected={selected()} onSelect={() => {}} liveTabs={[]} />);
  await screen.findByText("beta");

  const { cost, artifact, lists } = await renderCost(container, () => setSelected(unit("beta")));

  expect(cost.mutations).toBeGreaterThan(0);
  expect(rowsChurned(lists)).toEqual([]);
  expect(artifact).toStayWithinRerunBudget(rerunBudget("sidebar.selection"));
  expect(renderDrift("sidebar.selection", cost), JSON.stringify(cost)).toEqual([]);
});
