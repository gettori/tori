import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createEvent, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
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
  stacked: true,
  saved: {} as Record<string, unknown>,
}));

const LAYERS: Record<string, number> = { schema: 1, api: 2, ui: 3 };

const status = (headRef: string): UnitStatus => {
  const position = bridge.stacked ? LAYERS[headRef] : undefined;
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
    reviews: [],
    requestedReviewers: [],
    viewerReview: null,
  };
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { project: string; order: unknown }) => {
    bridge.calls.push(cmd);
    if (cmd === "sidebar_order_read") return Promise.resolve(structuredClone(bridge.saved));
    if (cmd === "sidebar_order_write") {
      bridge.saved[args!.project] = structuredClone(args!.order);
      return Promise.resolve();
    }
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
const { resetSessionStoreForTests } = await import("../../utils/sessionStore");
const { resetSessionActivityForTests } = await import("../../utils/sessionActivity");
const { resetForgeStatusForTests, pollNow } = await import("../../utils/forgeStatus");
const { resetSidebarOrderForTests } = await import("../../utils/sidebarOrder");

const branchRows = () =>
  [...document.querySelectorAll("[class*='label']")]
    .map((el) => el.textContent ?? "")
    .filter((l) => bridge.branches.includes(l));
const rowOf = (label: string) => screen.getByText(label).closest("[draggable]")!;

function drag(from: string, onto: string) {
  const data: Record<string, string> = {};
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    setData: (t: string, v: string) => (data[t] = v),
    getData: (t: string) => data[t] ?? "",
  };
  const send = (el: Element, type: "dragStart" | "dragOver" | "drop") => {
    const ev = createEvent[type](el, { clientY: 0 });
    Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
    fireEvent(el, ev);
  };
  send(rowOf(from), "dragStart");
  send(rowOf(onto), "dragOver");
  send(rowOf(onto), "drop");
}

const mount = () => render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);

describe("the hand-made branch order", () => {
  beforeEach(() => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    resetForgeStatusForTests();
    resetSidebarOrderForTests();
    bridge.calls.length = 0;
    bridge.saved = {};
    bridge.stacked = true;
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/gh"]));
  });

  it("keeps a dragged row where it was dropped across a reload", async () => {
    bridge.branches = ["main", "a", "b", "c"];
    const view = mount();
    await waitFor(() => expect(branchRows()).toEqual(["main", "a", "b", "c"]));
    await waitFor(() => expect(bridge.calls).toContain("sidebar_order_write"));

    drag("c", "a");
    await waitFor(() => expect(branchRows()).toEqual(["main", "c", "a", "b"]));

    view.unmount();
    resetSidebarOrderForTests();
    mount();
    await waitFor(() => expect(branchRows()).toEqual(["main", "c", "a", "b"]));
  });

  it("holds the rows still for a poll while the pointer is over the list", async () => {
    bridge.stacked = false;
    bridge.branches = ["main", "schema", "api", "ui"];
    const { container } = mount();
    await waitFor(() => expect(branchRows()).toEqual(["main", "schema", "api", "ui"]));
    const tree = container.firstElementChild!;

    fireEvent.pointerEnter(tree);
    bridge.stacked = true;
    await pollNow("manual");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Stack")).toBeNull();

    fireEvent.pointerLeave(tree);
    await screen.findByText("Stack");
  });
});
