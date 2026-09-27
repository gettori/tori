import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import type { AuthState, PullRequest } from "../../../utils/forgeTypes";

// Every open pull request on a project, in one list.
//
// Drawn in two places and owned by neither: the right pane used to host it, and
// its own stage tab does now. What a picked row *does* differs between callers
// and is tested where the caller is; everything here is the list itself.
//
// Two things it has to get right that a working-looking list would not show:
//
//   1. **A long list must arrive whole.** The API pages at 100, so a repo with
//      150 open PRs is exactly where a list silently shows the first page and
//      looks perfectly healthy doing it.
//   2. **Every empty state must say which one it is.** Signed out, switched off,
//      failed, and genuinely empty all render nothing; a list that draws the
//      same blank for all four leaves the user with no idea what to do.

const ROOT = "/root/work/gh";

const pr = (n: number, over: Partial<PullRequest> = {}): PullRequest => ({
  number: n,
  title: `pull request ${n}`,
  body: null,
  state: "open",
  isDraft: false,
  createdAt: "2026-09-17T08:14:00Z",
  mergedAt: null,
  closedAt: null,
  comments: 0,
  author: "skarif2",
  headRef: `branch-${n}`,
  baseRef: "main",
  headSha: `sha${n}`,
  headRepoIsOrigin: true,
  url: `https://github.com/skarif2/tori/pull/${n}`,
  mergeableState: "clean",
  ...over,
});

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  items: [] as unknown[],
  statuses: [] as unknown[],
  truncated: false,
  fail: null as { kind: string; message: string } | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "forge_list_prs") {
      return bridge.fail
        ? Promise.reject(bridge.fail)
        : Promise.resolve({ items: bridge.items, truncated: bridge.truncated });
    }
    if (cmd === "forge_unit_statuses")
      return Promise.resolve({
        statuses: bridge.statuses,
        uncovered: 0,
        rate: { remaining: 4800, limit: 5000, resetAt: null },
      });
    if (cmd === "forge_repo_account")
      return Promise.resolve({
        kind: "account",
        accountId: "personal",
        host: "github.com",
        auth: { kind: "signedIn", login: "skarif2" },
      });
    return Promise.resolve(null);
  },
}));

const { default: PrList } = await import("./PrList");
const { noteForgeAccounts, noteForgeEnabled, noteWatchedProjects, resetForgeStatusForTests, pollNow } =
  await import("../../../utils/forgeStatus");
const { resetPrListStoreForTests } = await import("../../../utils/prListStore");

/** The one account these tests act as, in this state. Signed out is no account. */
const noteAuth = (auth: AuthState) =>
  noteForgeAccounts(
    auth.kind === "signedOut"
      ? []
      : [{ id: "personal", provider: "github", baseUrl: "https://github.com", login: "skarif2", label: "skarif2", expiresAt: null, rejectedAt: null, scopes: null, source: "token", orgAccess: [], auth }],
  );

const signIn = () => {
  noteAuth({ kind: "signedIn", login: "skarif2" });
  noteForgeEnabled(true);
};

describe("the pull request list", () => {
  beforeEach(() => {
    resetPrListStoreForTests();
    resetForgeStatusForTests();
    bridge.calls.length = 0;
    bridge.items = [];
    bridge.statuses = [];
    bridge.truncated = false;
    bridge.fail = null;
  });

  it("lists every pull request a paged repo has, not the first page", async () => {
    // 150 is past the API's 100-per-page cut. Rust walks the `Link` header to
    // exhaustion; what this pins is that the panel renders whatever came back
    // rather than slicing it to something that fits.
    bridge.items = Array.from({ length: 150 }, (_, i) => pr(i + 1));
    signIn();

    render(() => <PrList root={ROOT} onPick={() => {}} />);

    await waitFor(() => expect(screen.queryByText("pull request 1")).toBeTruthy());
    expect(screen.queryByText("pull request 150")).toBeTruthy();
    expect(screen.queryAllByText(/^pull request \d+$/)).toHaveLength(150);
  });

  it("says so when the server could not send them all", async () => {
    // The page cap. A short list that looks complete is the failure nobody
    // reports, so the truncation is a sentence rather than an absence.
    bridge.items = [pr(1)];
    bridge.truncated = true;
    signIn();

    render(() => <PrList root={ROOT} onPick={() => {}} />);
    await waitFor(() =>
      expect(screen.queryByText(/more open pull requests than one listing can carry/)).toBeTruthy(),
    );
  });

  it("tells the four ways of being empty apart", async () => {
    // Each of these renders no rows, and each needs a different next action:
    // turn it back on, sign in, sign in again, or nothing at all.
    signIn();
    const empty = render(() => <PrList root={ROOT} onPick={() => {}} />);
    await waitFor(() => expect(empty.queryByText("No open pull requests.")).toBeTruthy());
    empty.unmount();

    noteAuth({ kind: "signedOut" });
    const out = render(() => <PrList root={ROOT} onPick={() => {}} />);
    expect(out.queryByText(/Sign in to GitHub in Settings/)).toBeTruthy();
    out.unmount();

    noteAuth({ kind: "signedIn", login: "skarif2" });
    noteForgeEnabled(false);
    const off = render(() => <PrList root={ROOT} onPick={() => {}} />);
    expect(off.queryByText(/switched off in Settings/)).toBeTruthy();
    off.unmount();

    noteForgeEnabled(true);
    noteAuth({ kind: "suspect", login: "skarif2" });
    const suspect = render(() => <PrList root={ROOT} onPick={() => {}} />);
    await waitFor(() => expect(suspect.queryByText(/rejected the stored credential/)).toBeTruthy());
    suspect.unmount();
  });

  it("never asks while the integration is paused", async () => {
    // Rust refuses too, but a request the frontend does not make is the half
    // that costs nothing at all - and the pause is exactly the state where the
    // answer could not be shown even if it arrived.
    noteAuth({ kind: "signedOut" });
    render(() => <PrList root={ROOT} onPick={() => {}} />);
    await Promise.resolve();
    expect(bridge.calls.filter((c) => c.cmd === "forge_list_prs")).toHaveLength(0);
  });

  it("shows the server's own sentence when the listing fails", async () => {
    // `String(e)` on a rejected forge command renders "[object Object]", which
    // is the least useful string in the app for the failure a user most needs
    // to act on.
    bridge.fail = { kind: "rateLimited", message: "the GitHub rate limit is spent" };
    signIn();

    render(() => <PrList root={ROOT} onPick={() => {}} />);
    await waitFor(() => expect(screen.queryByText("the GitHub rate limit is spent")).toBeTruthy());
  });

  it("picks up a pull request opened from the Changes panel", async () => {
    // Rust's create write-through makes the sidebar chip flip at once, but this
    // list is its own request and would keep showing the state before the
    // create until somebody hit Refresh.
    signIn();
    render(() => <PrList root={ROOT} onPick={() => {}} />);
    await waitFor(() => expect(screen.queryByText("No open pull requests.")).toBeTruthy());

    bridge.items = [pr(31)];
    window.dispatchEvent(
      new CustomEvent("tori:pr-opened", { detail: { projectPath: ROOT } }),
    );
    await waitFor(() => expect(screen.queryByText("pull request 31")).toBeTruthy());
  });

  it("ignores a pull request opened in a different project", async () => {
    // Two projects can be open at once, and re-listing on someone else's create
    // spends a request to render exactly what is already on screen.
    bridge.items = [pr(1)];
    signIn();
    render(() => <PrList root={ROOT} onPick={() => {}} />);
    await waitFor(() => expect(screen.queryByText("pull request 1")).toBeTruthy());

    const before = bridge.calls.filter((c) => c.cmd === "forge_list_prs").length;
    window.dispatchEvent(
      new CustomEvent("tori:pr-opened", { detail: { projectPath: "/root/work/other" } }),
    );
    await Promise.resolve();
    expect(bridge.calls.filter((c) => c.cmd === "forge_list_prs")).toHaveLength(before);
  });

  it("takes its checks from the same store the sidebar chip reads", async () => {
    // Not a second fetch. Two sources for one question is how a row and its
    // chip end up disagreeing, and the poller has already asked.
    bridge.items = [pr(7, { headRef: "wave-3" })];
    bridge.statuses = [
      {
        headRef: "wave-3",
        pullRequest: pr(7, { headRef: "wave-3" }),
        checks: { state: "failure", total: 4, failing: 1, contexts: [] },
        reviewDecision: "changesRequested",
      },
    ];
    signIn();
    noteWatchedProjects([{ path: ROOT, units: [{ branch: "wave-3", visible: true }] }]);

    render(() => <PrList root={ROOT} onPick={() => {}} />);
    await waitFor(() => expect(screen.queryByText("pull request 7")).toBeTruthy());
    // Nothing has polled yet, so no checks badge: the same honest blank the
    // chip shows for a branch no tick has covered.
    expect(document.querySelector("[data-forge-checks]")).toBeNull();

    const before = bridge.calls.length;
    await pollNow("manual");

    await waitFor(() =>
      expect(document.querySelector('[data-forge-checks="bad"]')).toBeTruthy(),
    );
    expect(document.querySelector('[data-forge-review="bad"]')).toBeTruthy();
    // And the panel asked for none of it: every request since the row rendered
    // was the poller's.
    expect(
      bridge.calls.slice(before).filter((c) => c.cmd === "forge_list_prs"),
    ).toHaveLength(0);
  });
});
