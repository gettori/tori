import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import type { StatusReport, UnitStatus } from "../../utils/forgeTypes";

const GH = "/root/work/gh";

const worktree = (branch: string) => ({
  label: branch,
  folderPath: `${GH}/${branch}`,
  branch,
  kind: "worktree",
  isCurrent: false,
});

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  units: [] as unknown[],
}));

const config = () => ({
  path: "/cfg/tori.toml",
  roots: ["/root"],
  spaces: [{ name: "work", path: "/root/work", projects: [{ name: "gh", path: GH, branchUnits: bridge.units }] }],
});

const request = (n: number, author: string) => ({
  key: String(n),
  display: `#${n}`,
  title: `pr ${n}`,
  url: `https://github.com/skarif2/tori/pull/${n}`,
  kind: "reviewRequest",
  author,
  headSha: `sha${n}`,
});

const REPORT: StatusReport = {
  statuses: [
    {
      headRef: "feature",
      pullRequest: { number: 46, author: "ana", state: "open" } as UnitStatus["pullRequest"],
      checks: { state: "none", total: 0, failing: 0, contexts: [] },
      reviewDecision: "none",
    },
  ],
  uncovered: 0,
  rate: { remaining: 4800, limit: 5000, resetAt: null },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "get_config") return Promise.resolve(config());
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "list_project_attempts") return Promise.resolve([]);
    if (cmd === "folder_historical") return Promise.resolve(false);
    if (cmd === "git_origin") return Promise.resolve("git@github.com:skarif2/tori.git");
    if (cmd === "forge_accounts") {
      const auth = { kind: "signedIn", login: "skarif2" };
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
              auth,
            },
          ],
        },
      ]);
    }
    if (cmd === "forge_repo_account")
      return Promise.resolve({
        kind: "account",
        accountId: "personal",
        host: "github.com",
        auth: { kind: "signedIn", login: "skarif2" },
      });
    if (cmd === "forge_unit_statuses") return Promise.resolve(REPORT);
    if (cmd === "review_requests")
      return Promise.resolve({
        rows: [request(45, "bo"), request(46, "ana"), request(47, "cy"), request(48, "di")],
        complete: true,
      });
    if (cmd === "create_review_worktree") {
      bridge.units = [...bridge.units, worktree("pr-47")];
      return Promise.resolve(`${GH}/pr-47`);
    }
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
const { resetForgeStatusForTests } = await import("../../utils/forgeStatus");

describe("review requests on the project row", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    resetForgeStatusForTests();
    bridge.calls.length = 0;
    bridge.units = [worktree("pr-45"), worktree("feature")];
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/gh"]));
  });

  it("counts only requests with no worktree, and opens the picked one as a selected worktree", async () => {
    const onSelect = vi.fn();
    render(() => <LeftSidebar selected={null} onSelect={onSelect} liveTabs={[]} />);

    const mark = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-review-requests]");
      expect(el?.dataset.reviewRequests).toBe("2");
      return el!;
    });
    expect(mark.textContent).toContain("2");

    pointerClick(mark);
    expect(screen.queryByRole("menuitem", { name: /#45/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /#46/ })).toBeNull();
    pointerClick(await screen.findByRole("menuitem", { name: "#47 pr 47, cy" }));

    await waitFor(() =>
      expect(bridge.calls.find((c) => c.cmd === "create_review_worktree")?.args).toEqual({
        projectPath: GH,
        number: 47,
      }),
    );
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ folderPath: `${GH}/pr-47`, branch: "pr-47" })),
    );
  });
});
