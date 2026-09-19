import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ForgeAccount, PrFile, PullRequest, StatusReport } from "./forgeTypes";

// The per-pull-request store, driven through the Tauri boundary.
//
// `.tsx` with no JSX in it, on purpose: the test config splits environments by
// extension, and a draft that survives a relaunch needs `localStorage`, which
// the node project has no window to hang off.
//
// Two kinds of assertion here, and both are about something a working-looking
// app would never show. **Requests not made**, because four tabs of one pull
// request quietly costing four reads of every patch only ever surfaces as an
// hourly budget running out later. And **an anchor that no longer fits**,
// because `forge_submit_review` carries no commit id: a comment written against
// a patch two commits old is accepted and lands on whatever occupies that line
// today.

type Ask = { cmd: string; args: Record<string, unknown> };

const calls: Ask[] = [];
let files: PrFile[] = [];
let filesTruncated = false;
/** Set to hold `forge_pr_files` open, so a second read can overtake it, and the
 *  handle that lets the held one answer. */
let filesGate: (() => void) | null = null;
let release: (() => void) | null = null;
let threads: unknown[] = [];
let mergeable = "clean";
let report: StatusReport | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    if (cmd === "forge_pr_files") {
      // Snapshotted before the gate, so a held read answers with the fixture
      // that was in place when it was asked, not the one set up after it.
      const answer = { items: files, truncated: filesTruncated };
      if (filesGate) {
        filesGate = null;
        await new Promise<void>((go) => {
          release = go;
        });
      }
      return answer;
    }
    if (cmd === "forge_review_threads") return { items: threads, truncated: false };
    if (cmd === "forge_mergeability") return mergeable;
    if (cmd === "forge_unit_statuses") return report ?? { statuses: [], uncovered: 0, rate: RATE };
    if (cmd === "forge_repo_account") {
      return {
        kind: "account",
        accountId: "personal",
        host: "github.com",
        auth: { kind: "signedIn", login: "skarif2" },
        capabilities: {},
      };
    }
    return null;
  },
}));

const {
  addPending,
  anchorStateFor,
  clearDraft,
  ensure,
  headDrift,
  parseDrafts,
  prEntry,
  refresh,
  resetPrReviewStoreForTests,
  setReviewBody,
  PR_REVIEW_DRAFTS_KEY,
} = await import("./prReviewStore");
const { noteForgeAccounts, noteForgeEnabled, noteWatchedProjects, pollNow, resetForgeStatusForTests, resolveForgeRepo } =
  await import("./forgeStatus");

const ROOT = "/root/work/gh";
const BRANCH = "wave-3";
const SHA_A = "9f1c2a3b4d5e6f708192a3b4c5d6e7f809a1b2c3";
const SHA_B = "1122334455667788990011223344556677889900";
const RATE = { remaining: null, limit: null, resetAt: null };

const cmds = (name: string) => calls.filter((c) => c.cmd === name);

const file = (over: Partial<PrFile> = {}): PrFile => ({
  path: "src/edit.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,3 +1,3 @@\n one\n-two\n+two edited\n three",
  ...over,
});

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: "Let a pull request be read in place",
  body: null,
  state: "open",
  isDraft: false,
  createdAt: "2026-09-17T08:14:00Z",
  comments: 0,
  author: "skarif2",
  headRef: BRANCH,
  baseRef: "main",
  headSha: SHA_A,
  url: "https://github.com/skarif2/tori/pull/42",
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

/** Let the poll cover this branch with a pull request at `sha`. */
async function pollWith(sha: string) {
  report = {
    statuses: [
      {
        headRef: BRANCH,
        pullRequest: pr({ headSha: sha }),
        checks: { state: "success", total: 1, failing: 0 },
        reviewDecision: "none",
      },
    ],
    uncovered: 0,
    rate: RATE,
  };
  await pollNow("manual");
}

/** Everything the poll store needs before it will answer at all. */
async function signIn() {
  noteForgeEnabled(true);
  noteForgeAccounts([account]);
  noteWatchedProjects([{ path: ROOT, units: [{ branch: BRANCH, visible: true }] }]);
  await resolveForgeRepo(ROOT);
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const held = (over: Partial<Parameters<typeof addPending>[2]> = {}) => ({
  path: "src/edit.ts",
  line: 2,
  side: "RIGHT" as const,
  startLine: null,
  startSide: null,
  body: "a note",
  rowText: "+two edited",
  ...over,
});

describe("the pull request review store", () => {
  beforeEach(() => {
    calls.length = 0;
    files = [file()];
    filesTruncated = false;
    filesGate = null;
    release = null;
    threads = [];
    mergeable = "clean";
    report = null;
    localStorage.clear();
    resetPrReviewStoreForTests();
    resetForgeStatusForTests();
  });

  it("keeps one pull request's late answer out of another's files", async () => {
    // The failure this guards is silent: both reads succeed, and the slower one
    // lands last. A reader would be looking at PR 1's diff under PR 2's number
    // with nothing on screen saying so.
    filesGate = () => {};
    files = [file({ path: "one.ts" })];
    ensure(ROOT, 1);
    await settle();

    files = [file({ path: "two.ts" })];
    ensure(ROOT, 2);
    await settle();

    release?.();
    await settle();

    expect(prEntry(ROOT, 2).files.map((f) => f.path)).toEqual(["two.ts"]);
    expect(prEntry(ROOT, 1).files.map((f) => f.path)).toEqual(["one.ts"]);
  });

  it("reads each part once however many consumers ask", async () => {
    ensure(ROOT, 42);
    ensure(ROOT, 42);
    ensure(ROOT, 42);
    await settle();

    expect(cmds("forge_pr_files")).toHaveLength(1);
    expect(cmds("forge_review_threads")).toHaveLength(1);
    expect(cmds("forge_mergeability")).toHaveLength(1);
    expect(prEntry(ROOT, 42).files).toHaveLength(1);
  });

  it("re-reads only the part a refresh names", async () => {
    ensure(ROOT, 42);
    await settle();
    calls.length = 0;

    await refresh(ROOT, 42, "threads");

    expect(cmds("forge_review_threads")).toHaveLength(1);
    expect(cmds("forge_pr_files")).toHaveLength(0);
    expect(cmds("forge_mergeability")).toHaveLength(0);
  });

  it("flips to drift when the head moves, and clears it on a files read", async () => {
    await signIn();
    await pollWith(SHA_A);

    ensure(ROOT, 42);
    await settle();
    expect(prEntry(ROOT, 42).headSha).toBe(SHA_A);
    expect(headDrift(ROOT, 42)).toBe(false);

    // A comment written against the patch in hand, and then two commits.
    addPending(ROOT, 42, held());
    // The store works the verdict out from the patches it holds, so a call site
    // cannot hand it a wrong one or forget it.
    expect(prEntry(ROOT, 42).pending[0].anchor).toBe("ok");
    await pollWith(SHA_B);
    expect(headDrift(ROOT, 42)).toBe(true);

    // The new patch no longer has line 2 at all, so re-reading the files is
    // what has to notice: the server would take the comment and place it.
    files = [file({ patch: "@@ -9,1 +9,1 @@\n-nine\n+nine edited" })];
    await refresh(ROOT, 42, "files");

    expect(headDrift(ROOT, 42)).toBe(false);
    expect(prEntry(ROOT, 42).pending[0].anchor).toBe("stale");
  });

  describe("an anchor against the patch in hand", () => {
    const patch = [file()];

    it("reads neither stale nor moved while its row is unchanged", () => {
      expect(anchorStateFor(patch, held(), "+two edited")).toBe("ok");
    });

    it("reads moved when the line now holds different text", () => {
      expect(anchorStateFor(patch, held(), "+two edited differently")).toBe("moved");
    });

    it("reads stale when the patch no longer reaches the line", () => {
      const short = [file({ patch: "@@ -1,1 +1,1 @@\n-a\n+b" })];
      expect(anchorStateFor(short, held({ line: 40 }), "+forty")).toBe("stale");
    });
  });

  it("carries a draft across a relaunch and drops it on submit", async () => {
    ensure(ROOT, 42);
    await settle();
    addPending(ROOT, 42, held());
    setReviewBody(ROOT, 42, "looks close");

    // What a relaunch actually is: the key survives, nothing in memory does.
    const stored = localStorage.getItem(PR_REVIEW_DRAFTS_KEY);
    resetPrReviewStoreForTests();
    expect(prEntry(ROOT, 42).pending).toHaveLength(0);
    localStorage.setItem(PR_REVIEW_DRAFTS_KEY, stored!);

    ensure(ROOT, 42);
    await settle();
    expect(prEntry(ROOT, 42).pending.map((c) => c.body)).toEqual(["a note"]);
    expect(prEntry(ROOT, 42).reviewBody).toBe("looks close");

    clearDraft(ROOT, 42);
    expect(localStorage.getItem(PR_REVIEW_DRAFTS_KEY)).toBe("{}");
  });

  it("drops a draft older than the cap when it loads", () => {
    const now = 1_785_179_400_000;
    const raw = JSON.stringify({
      [`${ROOT}\n42`]: { headSha: SHA_A, pending: [], reviewBody: "old", composers: [], viewed: [], savedAt: now - 15 * 24 * 60 * 60 * 1000 },
      [`${ROOT}\n43`]: { headSha: SHA_A, pending: [], reviewBody: "new", composers: [], viewed: [], savedAt: now - 60_000 },
    });
    expect(Object.keys(parseDrafts(raw, now))).toEqual([`${ROOT}\n43`]);
  });

  // The two below are one assertion split across two tests on purpose: the
  // store outlives any component, so without the reset seam the first one's
  // draft is what the second one reads.
  it("holds a draft on PR 42", async () => {
    ensure(ROOT, 42);
    await settle();
    addPending(ROOT, 42, held());
    expect(prEntry(ROOT, 42).pending).toHaveLength(1);
  });

  it("sees no draft on PR 42 from the test before it", async () => {
    ensure(ROOT, 42);
    await settle();
    expect(prEntry(ROOT, 42).pending).toHaveLength(0);
  });
});
