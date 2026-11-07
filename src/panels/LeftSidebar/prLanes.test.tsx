import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { createEvent, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
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
  prs: {} as Record<string, { state?: "open" | "merged"; isDraft?: boolean; decision?: "changesRequested" }>,
  saved: {} as Record<string, unknown>,
}));

const status = (headRef: string, i: number): UnitStatus => {
  const pr = bridge.prs[headRef];
  const pullRequest: PullRequest | null = pr
    ? {
        number: 100 + i,
        title: headRef,
        body: null,
        state: pr.state ?? "open",
        isDraft: pr.isDraft ?? false,
        author: "skarif2",
        createdAt: "2026-10-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        comments: 0,
        headRef,
        baseRef: "main",
        headSha: "sha",
        headRepoIsOrigin: true,
        url: `https://github.com/skarif2/tori/pull/${100 + i}`,
        mergeableState: "clean",
        stack: null,
      }
    : null;
  return {
    headRef,
    pullRequest,
    checks: { state: "none", total: 0, failing: 0, skipped: 0, contexts: [] },
    reviewDecision: pr?.decision ?? "none",
    reviews: [],
    requestedReviewers: [],
    viewerReview: null,
  };
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { project: string; order: unknown; settings: unknown }) => {
    if (cmd === "set_settings") return Promise.resolve(args!.settings);
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
const { resetForgeStatusForTests } = await import("../../utils/forgeStatus");
const { resetSidebarOrderForTests } = await import("../../utils/sidebarOrder");
const { setLanes, resetLanes, setSidebar } = await import("../Settings/settingsStore");
const { LANE_HUE } = await import("../../utils/prLanes");

const mount = () => render(() => <LeftSidebar selected={null} onSelect={() => {}} liveTabs={[]} />);
const lane = (id: string) => document.querySelector<HTMLElement>(`[data-lane="${id}"]`);
const rowOf = (label: string) => screen.getByText(label).closest("[draggable]") as HTMLElement;

function dragEvent(el: Element, type: "dragStart" | "dragOver" | "drop", dataTransfer: object) {
  const ev = createEvent[type](el, { clientY: 2 });
  Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
  // jsdom's DragEvent drops `clientY` from its init.
  Object.defineProperty(ev, "clientY", { value: 2 });
  fireEvent(el, ev);
}

describe("PR lanes", () => {
  beforeEach(async () => {
    resetSessionStoreForTests();
    resetSessionActivityForTests();
    resetForgeStatusForTests();
    resetSidebarOrderForTests();
    bridge.saved = {};
    bridge.branches = ["wip", "fix", "shipped", "fresh"];
    bridge.prs = { wip: { isDraft: true }, fix: { decision: "changesRequested" }, shipped: { state: "merged" } };
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    localStorage.setItem("tori.active-space.v1", "work");
    localStorage.setItem("tori.expanded.v1", JSON.stringify(["p:work/gh"]));
    await setSidebar({ cardColours: "subtle" });
    await resetLanes("work");
    await setLanes(null, { enabled: true });
  });

  it("opens Working and lit lanes, parks Done, and keeps an unparked lane open across a reload", async () => {
    const view = mount();
    await waitFor(() => expect(lane("changesRequested")?.tagName).toBe("DIV"));
    expect(within(lane("working")!).getByText("wip")).toBeTruthy();
    expect(within(lane("working")!).getByText("fresh")).toBeTruthy();
    expect(within(lane("changesRequested")!).getByText("fix")).toBeTruthy();
    const done = lane("done")!;
    expect(done.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("shipped")).toBeNull();

    fireEvent.click(done);
    await screen.findByText("shipped");
    view.unmount();
    const again = mount();
    await waitFor(() => expect(lane("done")?.tagName).toBe("DIV"));
    expect(within(lane("done")!).getByText("shipped")).toBeTruthy();

    fireEvent.click(within(lane("done")!).getByRole("button", { expanded: true }));
    await waitFor(() => expect(screen.queryByText("shipped")).toBeNull());
    again.unmount();
    mount();
    await waitFor(() => expect(lane("done")?.getAttribute("aria-expanded")).toBe("false"));
    expect(screen.queryByText("shipped")).toBeNull();
  });

  it("refuses a drop into another lane and leaves the order as it was", async () => {
    mount();
    await waitFor(() => expect(lane("changesRequested")).toBeTruthy());
    await waitFor(() => expect(bridge.saved[GH]).toBeTruthy());
    const before = structuredClone(bridge.saved[GH]);

    const data: Record<string, string> = {};
    const dt = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: (t: string, v: string) => (data[t] = v),
      getData: (t: string) => data[t] ?? "",
    };
    const onto = rowOf("wip");
    onto.getBoundingClientRect = () => ({ top: 0, height: 40 }) as DOMRect;
    dragEvent(rowOf("fix"), "dragStart", dt);
    dragEvent(onto, "dragOver", dt);
    expect(dt.dropEffect).toBe("none");
    expect(onto.getAttribute("data-drop")).toBe("refused");
    await screen.findByText("Lanes follow PR state. Reorder inside Changes requested, or drop into a group.");
    dragEvent(onto, "drop", dt);

    await waitFor(() => expect(screen.queryByText(/Lanes follow PR state/)).toBeNull());
    expect(bridge.saved[GH]).toEqual(before);
    expect(within(lane("changesRequested")!).getByText("fix")).toBeTruthy();
  });

  it("draws every card on the one neutral surface in Subtle and in its lane's hue in Colourful", async () => {
    mount();
    await waitFor(() => expect(lane("changesRequested")).toBeTruthy());
    const ids = ["working", "changesRequested", "done"] as const;
    const hues = () => ids.map((id) => lane(id)?.dataset.hue ?? null);
    expect(hues()).toEqual([null, null, null]);
    await setSidebar({ cardColours: "colourful" });
    await waitFor(() => expect(hues()).toEqual(ids.map((id) => LANE_HUE[id])));
    expect(new Set(hues()).size).toBe(3);
  });
});
