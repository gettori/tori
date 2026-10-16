import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import type { PullRequest, StatusReport, UnitStatus } from "../../utils/forgeTypes";

const GH = "/root/work/gh";

const worktree = (branch: string) => ({
  label: branch,
  folderPath: `${GH}/${branch}`,
  branch,
  kind: "worktree",
  isCurrent: false,
});

const bridge = vi.hoisted(() => ({
  branches: [] as string[],
  calls: [] as string[],
}));

const LAYERS: Record<string, number> = { schema: 1, api: 2, ui: 3 };

const status = (headRef: string): UnitStatus => {
  const position = LAYERS[headRef];
  const pullRequest: PullRequest | null = position
    ? {
        number: 470 + position,
        title: headRef,
        body: null,
        state: "open",
        isDraft: false,
        author: "skarif2",
        createdAt: "2026-10-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        comments: 0,
        headRef,
        baseRef: "main",
        headSha: "sha",
        headRepoIsOrigin: true,
        url: `https://github.com/skarif2/tori/pull/${470 + position}`,
        mergeableState: "clean",
        stack: { number: 470, size: 3, position, baseRef: "main" },
      }
    : null;
  return {
    headRef,
    pullRequest,
    checks: { state: "none", total: 0, failing: 0, skipped: 0, contexts: [] },
    reviewDecision: "none",
  };
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.calls.push(cmd);
    if (cmd === "get_config")
      return Promise.resolve({
        path: "/cfg/tori.toml",
        roots: ["/root"],
        spaces: [
          {
            name: "work",
            path: "/root/work",
            projects: [{ name: "gh", path: GH, branchUnits: bridge.branches.map(worktree) }],
          },
        ],
      });
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve("git@github.com:skarif2/tori.git");
    if (cmd === "forge_accounts")
      return Promise.resolve([
        {
          host: "github.com",
          accounts: [
            {
              id: "personal",
              provider: "github",
              baseUrl: "https://github.com",
              login: "skarif2",
              label: "skarif2",
              expiresAt: null,
              auth: { kind: "signedIn", login: "skarif2" },
            },
          ],
        },
      ]);
    if (cmd === "forge_repo_account")
      return Promise.resolve({
        kind: "account",
        accountId: "personal",
        host: "github.com",
        auth: { kind: "signedIn", login: "skarif2" },
      });
    if (cmd === "forge_unit_statuses")
      return Promise.resolve({
        statuses: bridge.branches.map(status),
        uncovered: 0,
        rate: { remaining: 4800, limit: 5000, resetAt: null },
      } satisfies StatusReport);
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
const { emitWith, NAVIGATE } = await import("../../utils/events");
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { resetForgeStatusForTests } = await import("../../utils/forgeStatus");

type Picked = { folderPath?: string; branch?: string } | null;

const rowLabels = () => [...document.querySelectorAll("[class*='label']")].map((el) => el.textContent);

function mount(selected: string | null = null) {
  const picked: Picked[] = [];
  const sel = selected
    ? ({ spaceName: "work", projectName: "gh", folderPath: `${GH}/${selected}`, branch: selected } as never)
    : null;
  render(() => <LeftSidebar selected={sel} onSelect={(s) => picked.push(s as Picked)} liveTabs={[]} />);
  return picked;
}

describe("a stack in the project card", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    resetForgeStatusForTests();
    bridge.calls.length = 0;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/gh"]));
  });

  it("counts as one entry against the cap, so seven units with three stacked cut nothing", async () => {
    bridge.branches = ["main", "a", "schema", "b", "api", "c", "ui"];
    mount();
    await screen.findByText("Stack");
    expect(screen.queryByText(/more branch/)).toBeNull();
    const labels = rowLabels();
    for (const b of bridge.branches) expect(labels).toContain(b);
    const order = labels.filter((l) => ["ui", "api", "schema"].includes(l ?? ""));
    expect(order).toEqual(["ui", "api", "schema"]);
  });

  it("keeps a selected layer's group shown when the cap cuts the list", async () => {
    bridge.branches = ["main", "a", "b", "c", "d", "e", "f", "ui", "api", "schema"];
    mount("api");
    await screen.findByText("Stack");
    expect(screen.getByText("api")).toBeTruthy();
    expect(screen.getByText("1 more branch")).toBeTruthy();
    expect(screen.queryByText("f")).toBeNull();
  });

  it("opens a collapsed stack when navigation lands on one of its layers", async () => {
    bridge.branches = ["main", "schema", "api", "ui"];
    const picked = mount();
    fireEvent.click(await screen.findByText("Stack"));
    await waitFor(() => expect(screen.queryByText("api")).toBeNull());

    emitWith(NAVIGATE, { folder: `${GH}/api` });
    await screen.findByText("api");
    expect(picked[picked.length - 1]).toMatchObject({ folderPath: `${GH}/api`, branch: "api" });
  });
});
