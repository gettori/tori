import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../../test/axe";
import type { ForgeAccount, PrFile, PullRequest, ReviewThread, StatusReport } from "../../../utils/forgeTypes";

// Every file of a pull request in one tab.
//
// What these tests pin is the one thing this tab has that the per-file tabs do
// not: three hundred files are three hundred sections, and only the open ones
// are diffs. Everything else here is the same body the diff tab draws, so the
// assertions are that it still is one - a conversation, a composer and a file
// with no patch all behave inside a section exactly as they do in a tab.

let paneWidth = 2000;
globalThis.ResizeObserver = class {
  constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
  observe() {
    this.cb([{ contentRect: { width: paneWidth } }]);
  }
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ROOT = "/root/work/gh";
const BRANCH = "wave-3";
const SHA_A = "9f1c2a3b4d5e6f708192a3b4c5d6e7f809a1b2c3";
const RATE = { remaining: null, limit: null, resetAt: null };
const NUMBER = 42;

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  files: [] as unknown[],
  threads: [] as unknown[],
  report: null as unknown,
}));

const SUMMARY = {
  mergeableState: "clean",
  updatedAt: "2026-09-18T11:02:00Z",
  counts: {
    commits: 2,
    changedFiles: 1,
    additions: 1,
    deletions: 1,
    reviews: { approved: 0, changesRequested: 0 },
  },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "forge_pr_files") return Promise.resolve({ items: bridge.files, truncated: false });
    if (cmd === "forge_review_threads") {
      return Promise.resolve({ items: bridge.threads, truncated: false });
    }
    if (cmd === "forge_pr_summary") return Promise.resolve(SUMMARY);
    if (cmd === "forge_unit_statuses") {
      return Promise.resolve(bridge.report ?? { statuses: [], uncovered: 0, rate: RATE });
    }
    if (cmd === "forge_repo_account") {
      return Promise.resolve({
        kind: "account",
        accountId: "personal",
        host: "github.com",
        auth: { kind: "signedIn", login: "skarif2" },
        capabilities: FULL_CAPS,
      });
    }
    if (cmd === "list_sessions") return Promise.resolve([]);
    if (cmd === "sessions_running") return Promise.resolve([]);
    if (cmd === "git_blob_sizes") return Promise.resolve({ head: 31_744, base: 24_576 });
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));

const { default: PrAllFilesView } = await import("./PrAllFilesView");
const { prAllTabId, parseSyntheticId } = await import("../../../utils/syntheticTabs");
const { prEntry, resetPrReviewStoreForTests } = await import("../../../utils/prReviewStore");
const {
  noteForgeAccounts,
  noteForgeEnabled,
  noteWatchedProjects,
  pollNow,
  resetForgeStatusForTests,
  resolveForgeRepo,
} = await import("../../../utils/forgeStatus");
const { resetSessionActivityForTests } = await import("../../../utils/sessionActivity");

const cmds = (name: string) => bridge.calls.filter((c) => c.cmd === name);

const FULL_CAPS = {
  pullRequests: true,
  checks: true,
  reviewThreads: true,
  resolveThreads: true,
  merge: true,
  approve: true,
  requestChanges: true,
  commentReview: true,
  singleComment: true,
};

const PATCH = ["@@ -1,3 +1,3 @@", " one", "-two", "+two edited", " three"].join("\n");

const file = (over: Partial<PrFile> = {}): PrFile => ({
  path: "src/edit.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: PATCH,
  ...over,
});

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: NUMBER,
  title: "Let a pull request be read in one scroll",
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
  headSha: SHA_A,
  headRepoIsOrigin: true,
  url: "https://github.com/skarif2/tori/pull/42",
  mergeableState: "clean",
  ...over,
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "PRRT_1",
  path: "src/edit.ts",
  line: 2,
  startLine: null,
  diffHunk: PATCH,
  isResolved: false,
  isOutdated: false,
  comments: [{ id: "C1", author: "reviewer", body: "a remark", createdAt: "" }],
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

async function pollWith(sha = SHA_A) {
  bridge.report = {
    statuses: [
      {
        headRef: BRANCH,
        pullRequest: pr({ headSha: sha }),
        checks: { state: "success", total: 1, failing: 0, contexts: [] },
        reviewDecision: "none",
      },
    ],
    uncovered: 0,
    rate: RATE,
  } satisfies StatusReport;
  await pollNow("manual");
}

async function signIn() {
  noteForgeEnabled(true);
  noteForgeAccounts([account]);
  noteWatchedProjects([{ path: ROOT, units: [{ branch: BRANCH, visible: true }] }]);
  await resolveForgeRepo(ROOT);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Mount the tab the way the stage does: from a `prall` id. */
function openTab() {
  const t = parseSyntheticId(prAllTabId(ROOT, NUMBER))!;
  return render(() => <PrAllFilesView workspace={t.workspace} arg={t.arg} />);
}

const sections = () => document.querySelectorAll("[data-file-section]");
const bodies = () => document.querySelectorAll("[data-file-body]");
const toggleFor = (path: string) =>
  document.querySelector<HTMLButtonElement>(`[data-file-section="${path}"] button`)!;

const pane = () => document.querySelector<HTMLElement>("[class*=allFiles]")!;

const rowFor = (text: string) =>
  Array.from(document.querySelectorAll("[class*=commentable]")).find((r) =>
    r.textContent?.includes(text),
  )!;

describe("a pull request's files stacked in one tab", () => {
  beforeEach(async () => {
    bridge.calls.length = 0;
    paneWidth = 2000;
    bridge.files = [file(), file({ path: "src/other.ts", additions: 4, deletions: 0 })];
    bridge.threads = [];
    bridge.report = null;
    localStorage.clear();
    resetPrReviewStoreForTests();
    resetForgeStatusForTests();
    resetSessionActivityForTests();
    await signIn();
    await pollWith();
  });

  it("lists every file and mounts only the first ten diffs", async () => {
    // The whole reason the sections collapse. `PrFileBody` pairs words per hunk
    // for everything it is handed, so three hundred mounted bodies is three
    // hundred diffs laid out to show the one at the top.
    bridge.files = Array.from({ length: 300 }, (_, i) => file({ path: `src/f${i}.ts` }));
    openTab();

    await waitFor(() => expect(sections()).toHaveLength(300));
    expect(bodies()).toHaveLength(10);
    // Every file is named whether or not its diff is mounted: a collapsed
    // section is a file you have not read, not a file that is not there.
    expect(toggleFor("src/f299.ts")).toBeTruthy();
    expect(toggleFor("src/f0.ts").getAttribute("aria-expanded")).toBe("true");
    expect(toggleFor("src/f10.ts").getAttribute("aria-expanded")).toBe("false");

    // And opening one mounts exactly that one.
    fireEvent.click(toggleFor("src/f10.ts"));
    await waitFor(() => expect(bodies()).toHaveLength(11));
  });

  it("keeps which sections are open when the tab is not the one on screen", async () => {
    // The stage unmounts a synthetic view the moment another tab is active, so
    // the expanded set lives in the store. Held in the view, a reader who
    // checked something in another tab would come back to the first ten again.
    const first = openTab();
    await waitFor(() => expect(sections()).toHaveLength(2));
    fireEvent.click(toggleFor("src/edit.ts"));
    await waitFor(() => expect(bodies()).toHaveLength(1));
    first.unmount();

    openTab();
    await waitFor(() => expect(sections()).toHaveLength(2));
    expect(toggleFor("src/edit.ts").getAttribute("aria-expanded")).toBe("false");
    expect(toggleFor("src/other.ts").getAttribute("aria-expanded")).toBe("true");
    // One read of the files, however many times the tab has been mounted.
    expect(cmds("forge_pr_files")).toHaveLength(1);
  });

  it("carries a conversation and a composer inside a section", async () => {
    bridge.threads = [thread()];
    openTab();
    await waitFor(() => expect(screen.queryByText("a remark")).toBeTruthy());

    // The thread is inside its own file's section, not loose in the stack.
    const section = document.querySelector('[data-file-section="src/edit.ts"]')!;
    expect(section.querySelector('[data-thread-id="PRRT_1"]')).toBeTruthy();

    // And the composer is the same one the diff tab opens, writing into the
    // same draft: the tab is a container, not a second review surface.
    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    expect(box.getAttribute("aria-label")).toBe("Comment on src/edit.ts:2");
    fireEvent.input(box, { target: { value: "inside a section" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });

    await waitFor(() => expect(prEntry(ROOT, NUMBER).pending).toHaveLength(1));
    expect(prEntry(ROOT, NUMBER).pending[0]).toMatchObject({
      path: "src/edit.ts",
      line: 2,
      body: "inside a section",
    });
  });

  it("opens a collapsed file to reach the conversation in it", async () => {
    // Past the ten that open on arrival, stepping through only what is mounted
    // would walk a reader to the end of the pull request having passed most of
    // its conversations without a word.
    bridge.files = Array.from({ length: 12 }, (_, i) => file({ path: `src/f${i}.ts` }));
    bridge.threads = [thread({ id: "PRRT_late", path: "src/f11.ts" })];
    openTab();
    await waitFor(() => expect(sections()).toHaveLength(12));

    // The one conversation is in the twelfth file, which is collapsed, so
    // nothing on screen carries it.
    expect(bodies()).toHaveLength(10);
    expect(document.querySelector("[data-thread-id]")).toBeNull();

    fireEvent.keyDown(pane(), { key: "n" });
    await waitFor(() => expect(toggleFor("src/f11.ts").getAttribute("aria-expanded")).toBe("true"));
    expect((document.activeElement as HTMLElement).dataset.threadId).toBe("PRRT_late");

    // And the end is still the end: nothing further to reach, nothing opens.
    fireEvent.keyDown(pane(), { key: "n" });
    expect((document.activeElement as HTMLElement).dataset.threadId).toBe("PRRT_late");
  });

  it("names every section header, open or collapsed", async () => {
    // A collapsed section is a disclosure whose state is not in its text, and
    // the counts and the unresolved mark beside it are a glyph and two numbers.
    bridge.threads = [thread()];
    bridge.files = [file(), file({ path: "src/other.ts", additions: 4, deletions: 0 })];
    openTab();
    await waitFor(() => expect(bodies()).toHaveLength(2));
    fireEvent.click(toggleFor("src/other.ts"));
    await waitFor(() => expect(bodies()).toHaveLength(1));

    expect(toggleFor("src/edit.ts").getAttribute("aria-label")).toBe(
      "Modified, src/edit.ts, 1 added, 1 removed, 1 unresolved comment",
    );
    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });

  it("gives a file with no patch its own sentence rather than an empty section", async () => {
    bridge.files = [file({ path: "docs/logo.png", patch: null, additions: 0, deletions: 0 })];
    openTab();

    await waitFor(() => expect(screen.queryByText("Binary file, nothing to diff")).toBeTruthy());
    const section = document.querySelector('[data-file-section="docs/logo.png"]')!;
    expect(section.querySelector('[data-file-skip="noText"]')).toBeTruthy();
  });
});
