import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import type { ForgeAccount, PullRequest } from "../../../utils/forgeTypes";

// The project's pull requests, given a stage to be read on.
//
// The list itself is `PrList` and the right pane's tests already cover it. What
// is pinned here is the half that only exists in the stage: what a picked row
// does. That pick is the only way the app ever learns about a pull request on a
// branch this machine has not checked out, because there is no read by number
// and the poll only covers branches with units.

const ROOT = "/root/work/gh";
const BRANCH = "wave-3";
const RATE = { remaining: null, limit: null, resetAt: null };

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  items: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "forge_list_prs") return Promise.resolve({ items: bridge.items, truncated: false });
    if (cmd === "forge_pr_files") return Promise.resolve({ items: [], truncated: false });
    if (cmd === "forge_review_threads") return Promise.resolve({ items: [], truncated: false });
    if (cmd === "forge_unit_statuses") {
      return Promise.resolve({ statuses: [], uncovered: 0, rate: RATE });
    }
    if (cmd === "forge_repo_account") {
      return Promise.resolve({
        kind: "account",
        accountId: "personal",
        host: "github.com",
        auth: { kind: "signedIn", login: "skarif2" },
        capabilities: {},
      });
    }
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));

const { default: PrListView } = await import("./PrListView");
const { default: PrOverviewView } = await import("./PrOverviewView");
const { prTabId, parseSyntheticId } = await import("../../../utils/syntheticTabs");
const { prEntry, viewingPr, resetPrReviewStoreForTests } = await import(
  "../../../utils/prReviewStore"
);
const { resetPrListStoreForTests } = await import("../../../utils/prListStore");
const { onWith, OPEN_IN_EDITOR } = await import("../../../utils/events");
const {
  noteForgeAccounts,
  noteForgeEnabled,
  noteWatchedProjects,
  resetForgeStatusForTests,
  resolveForgeRepo,
} = await import("../../../utils/forgeStatus");
const { resetSessionActivityForTests } = await import("../../../utils/sessionActivity");

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 31,
  title: "Let a pull request be read in place",
  body: null,
  state: "open",
  isDraft: false,
  createdAt: "2026-09-17T08:14:00Z",
  mergedAt: null,
  closedAt: null,
  comments: 0,
  author: "skarif2",
  headRef: BRANCH,
  baseRef: "main",
  headSha: "9f1c2a3b4d5e6f708192a3b4c5d6e7f809a1b2c3",
  headRepoIsOrigin: true,
  url: "https://github.com/skarif2/tori/pull/31",
  mergeableState: "clean",
  ...over,
});

const account: ForgeAccount = {
  id: "personal",
  provider: "github",
  baseUrl: "https://github.com",
  login: "skarif2",
  label: "personal",
  expiresAt: null,
  rejectedAt: null,
  scopes: null,
  source: "token",
  orgAccess: [],
  auth: { kind: "signedIn", login: "skarif2" },
};

async function signIn() {
  noteForgeEnabled(true);
  noteForgeAccounts([account]);
  noteWatchedProjects([{ path: ROOT, units: [{ branch: BRANCH, visible: true }] }]);
  await resolveForgeRepo(ROOT);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const cmds = (name: string) => bridge.calls.filter((c) => c.cmd === name);

beforeEach(() => {
  bridge.calls.length = 0;
  bridge.items = [];
  localStorage.clear();
  resetPrReviewStoreForTests();
  resetPrListStoreForTests();
  resetForgeStatusForTests();
  resetSessionActivityForTests();
});

describe("the pull request list as a stage tab", () => {
  it("lists the project's pull requests and re-asks on Refresh", async () => {
    bridge.items = [pr({ number: 31, title: "the first one" })];
    await signIn();
    render(() => <PrListView workspace={ROOT} />);

    await waitFor(() => expect(screen.getByText("the first one")).toBeTruthy());
    const listed = cmds("forge_list_prs").length;

    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => expect(cmds("forge_list_prs").length).toBe(listed + 1));
  });

  it("hands the store the row it picked before opening its tab", async () => {
    // The order is the point. The tab reads the store on mount, so a pick that
    // opened first and told second would render "no pull request here carries
    // that number" over a pull request it was holding all along.
    const picked = pr({ number: 31, title: "the one picked" });
    bridge.items = [picked];
    await signIn();
    render(() => <PrListView workspace={ROOT} />);
    await waitFor(() => expect(screen.getByText("the one picked")).toBeTruthy());

    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, (e) => opened.push(e.path));
    fireEvent.click(screen.getByText("the one picked"));
    off();

    expect(prEntry(ROOT, 31).pr).toEqual(picked);
    expect(opened).toEqual([prTabId(ROOT, 31)]);
    // And the panel beside it follows the pick rather than the checked-out
    // branch, which is what makes its verdict rows about what was just opened.
    expect(viewingPr(ROOT)).toBe(31);
  });

  it("opens a pull request on a branch this machine has never checked out", async () => {
    // The poll only covers branches with units, and nothing can look a pull
    // request up by number. Without the pick handing its own row over, every
    // pull request on somebody else's branch would be unreachable.
    const elsewhere = pr({ number: 77, title: "somebody else's branch", headRef: "not-here" });
    bridge.items = [elsewhere];
    await signIn();
    render(() => <PrListView workspace={ROOT} />);
    await waitFor(() => expect(screen.getByText("somebody else's branch")).toBeTruthy());

    fireEvent.click(screen.getByText("somebody else's branch"));

    const t = parseSyntheticId(prTabId(ROOT, 77))!;
    render(() => <PrOverviewView workspace={t.workspace} arg={t.arg} />);

    await waitFor(() => expect(screen.getAllByText("somebody else's branch").length).toBe(2));
    expect(screen.queryByText("No pull request here carries that number.")).toBeNull();
  });
});
