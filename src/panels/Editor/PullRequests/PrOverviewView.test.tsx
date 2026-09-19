import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import type { ForgeAccount, PrFile, PullRequest, StatusReport } from "../../../utils/forgeTypes";

// The pull request itself, rather than one of its files.
//
// What these pin is the split the plan draws: this tab carries the description
// and the detail read's counts, and it carries no way to land the branch. The
// merge control is the panel's and only the panel's, because two controls that
// merge are two places a stale verdict can offer it.

const ROOT = "/root/work/gh";
const BRANCH = "wave-3";
const SHA = "9f1c2a3b4d5e6f708192a3b4c5d6e7f809a1b2c3";
const RATE = { remaining: null, limit: null, resetAt: null };

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  files: [] as unknown[],
  report: null as unknown,
  summary: null as unknown,
  capabilities: {} as Record<string, boolean>,
  submitFails: null as { kind: string; message: string } | null,
}));

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "forge_pr_files") return Promise.resolve({ items: bridge.files, truncated: false });
    if (cmd === "forge_submit_review")
      return bridge.submitFails ? Promise.reject(bridge.submitFails) : Promise.resolve(null);
    if (cmd === "forge_review_threads") return Promise.resolve({ items: [], truncated: false });
    if (cmd === "forge_pr_summary") return Promise.resolve(bridge.summary);
    if (cmd === "forge_unit_statuses") {
      return Promise.resolve(bridge.report ?? { statuses: [], uncovered: 0, rate: RATE });
    }
    if (cmd === "forge_repo_account") {
      return Promise.resolve({
        kind: "account",
        accountId: "personal",
        host: "github.com",
        auth: { kind: "signedIn", login: "skarif2" },
        capabilities: bridge.capabilities,
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

const { default: PrOverviewView } = await import("./PrOverviewView");
const { prTabId, prDiffTabId, parseSyntheticId } = await import("../../../utils/syntheticTabs");
const { addPending, prEntry, resetPrReviewStoreForTests } = await import(
  "../../../utils/prReviewStore"
);
const { onWith, OPEN_IN_EDITOR } = await import("../../../utils/events");
const {
  noteForgeAccounts,
  noteForgeEnabled,
  noteWatchedProjects,
  pollNow,
  resetForgeStatusForTests,
  resolveForgeRepo,
} = await import("../../../utils/forgeStatus");
const { resetSessionActivityForTests } = await import("../../../utils/sessionActivity");

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: "Let a pull request be read in place",
  body: "Moves the review **into the stage**.",
  state: "open",
  isDraft: false,
  createdAt: "2026-09-17T08:14:00Z",
  comments: 0,
  author: "skarif2",
  headRef: BRANCH,
  baseRef: "main",
  headSha: SHA,
  url: "https://github.com/skarif2/tori/pull/42",
  mergeableState: "clean",
  ...over,
});

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

/** Let the poll cover this branch, which is where the tab reads the pull
 *  request itself from: it opens by number and fetches none of this. */
async function pollWith(over: Partial<PullRequest> = {}) {
  bridge.report = {
    statuses: [
      {
        headRef: BRANCH,
        pullRequest: pr(over),
        checks: { state: "success", total: 1, failing: 0, contexts: [] },
        reviewDecision: "none",
      },
    ],
    uncovered: 0,
    rate: RATE,
  } satisfies StatusReport;
  await pollNow("manual");
}

/** Mount the tab the way the stage does: from a `pr` id. */
function openTab() {
  const t = parseSyntheticId(prTabId(ROOT, 42))!;
  return render(() => <PrOverviewView workspace={t.workspace} arg={t.arg} />);
}

const cmds = (name: string) => bridge.calls.filter((c) => c.cmd === name);

/** A held comment on the one row the fixture patch actually carries, so its
 *  anchor reads `ok` unless a test moves the diff under it. */
function holdComment(body = "this drops the error", line = 2, rowText = "+two edited") {
  addPending(ROOT, 42, {
    path: "src/edit.ts",
    line,
    side: "RIGHT",
    startLine: null,
    startSide: null,
    body,
    rowText,
  });
}

beforeEach(() => {
  bridge.calls.length = 0;
  bridge.files = [file()];
  bridge.capabilities = { ...FULL_CAPS };
  bridge.submitFails = null;
  bridge.report = null;
  bridge.summary = {
    mergeableState: "clean",
    updatedAt: "2026-09-18T11:02:00Z",
    counts: {
      commits: 7,
      changedFiles: 9,
      additions: 214,
      deletions: 38,
      reviews: { approved: 1, changesRequested: 2 },
    },
  };
  localStorage.clear();
  resetPrReviewStoreForTests();
  resetForgeStatusForTests();
  resetSessionActivityForTests();
});

describe("the pull request overview tab", () => {
  it("renders the description and the counts the detail read carries", async () => {
    await signIn();
    await pollWith();
    openTab();

    // The body is markdown, so the emphasis is an element rather than asterisks
    // in the text: this is the assertion that it went through the renderer.
    await waitFor(() => expect(screen.getByText("into the stage")).toBeTruthy());
    expect(screen.getByText("into the stage").tagName).toBe("STRONG");

    // None of these are on the listed `PullRequest`. They exist only on the
    // summary, which is the whole reason this phase widened that read.
    await waitFor(() => expect(screen.getByText("+214")).toBeTruthy());
    expect(screen.getByText("-38")).toBeTruthy();
    expect(screen.getByText(/7 commits, 9 files/)).toBeTruthy();
    expect(screen.getByText("1 approval")).toBeTruthy();
    expect(screen.getByText("2 change requests")).toBeTruthy();
  });

  it("offers no way to land the branch, which belongs to the panel", async () => {
    await signIn();
    await pollWith();
    openTab();

    await waitFor(() => expect(screen.getByText(/skarif2/)).toBeTruthy());
    for (const label of ["Merge", "Squash and merge", "Update branch"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });
});

describe("the review submitted from the overview tab", () => {
  const submit = () => screen.getByRole("button", { name: "Submit review" }) as HTMLButtonElement;

  it("opens the file a held comment sits in when its row is jumped to", async () => {
    // The jump is the whole reason the list is here: a pending comment read as
    // a line of text away from its rows is a remark about nothing.
    await signIn();
    await pollWith();
    openTab();
    await waitFor(() => expect(screen.getByText(/skarif2/)).toBeTruthy());
    holdComment();

    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, (e) => opened.push(e.path));
    fireEvent.click(await screen.findByText("this drops the error"));
    off();

    expect(opened).toEqual([prDiffTabId(ROOT, 42, "src/edit.ts")]);
  });

  it("refuses the submit while a comment no longer matches the diff", async () => {
    // `submit_review` sends no commit id, so the server re-resolves every
    // anchor against the diff it holds. A comment with nowhere to land is
    // refused before it is sent rather than after.
    await signIn();
    await pollWith();
    openTab();
    await waitFor(() => expect(screen.getByText(/skarif2/)).toBeTruthy());
    holdComment("about a line that is gone", 40);

    await waitFor(() => expect(submit().disabled).toBe(true));
    expect(screen.getByText(/no longer match the diff/)).toBeTruthy();
    // And the reader is told which one, or they have nothing to act on.
    expect(screen.getByText("line is gone")).toBeTruthy();
  });

  it("refuses the submit while the head has moved under the diff", async () => {
    await signIn();
    await pollWith();
    openTab();
    await waitFor(() => expect(screen.getByText(/skarif2/)).toBeTruthy());
    holdComment();
    await waitFor(() => expect(submit().disabled).toBe(false));

    await pollWith({ headSha: "0".repeat(40) });

    await waitFor(() => expect(submit().disabled).toBe(true));
    expect(screen.getByText(/new commits/)).toBeTruthy();
  });

  it("sends the held comments, drops the draft, and re-reads what it changed", async () => {
    await signIn();
    await pollWith();
    openTab();
    await waitFor(() => expect(screen.getByText(/skarif2/)).toBeTruthy());
    holdComment();
    await waitFor(() => expect(submit().disabled).toBe(false));

    const threadsBefore = cmds("forge_review_threads").length;
    const summaryBefore = cmds("forge_pr_summary").length;
    fireEvent.click(submit());

    await waitFor(() => expect(cmds("forge_submit_review")).toHaveLength(1));
    const sent = cmds("forge_submit_review")[0].args;
    expect(sent.event).toBe("comment");
    expect(sent.comments).toEqual([
      {
        path: "src/edit.ts",
        line: 2,
        side: "RIGHT",
        startLine: null,
        startSide: null,
        body: "this drops the error",
      },
    ]);

    // The draft is given up only once the one call landed: a failed submit has
    // to hand the whole set back.
    await waitFor(() => expect(prEntry(ROOT, 42).pending).toHaveLength(0));
    // Both parts the submit changed, and neither of the ones it did not.
    await waitFor(() =>
      expect(cmds("forge_review_threads").length).toBe(threadsBefore + 1),
    );
    expect(cmds("forge_pr_summary").length).toBe(summaryBefore + 1);
  });
  it("hands the whole draft back when the one call is refused", async () => {
    // The reason the review is one call: comments posted as they are written
    // and a verdict at the end leave a half-submitted review behind whenever
    // the last call fails, with nothing saying which ones already landed.
    // Here the set has to survive intact, or the reader loses every comment
    // they wrote to one refusal.
    bridge.submitFails = { kind: "forbidden", message: "you cannot review this pull request" };
    await signIn();
    await pollWith();
    openTab();
    await waitFor(() => expect(screen.getByText(/skarif2/)).toBeTruthy());
    holdComment();
    await waitFor(() => expect(submit().disabled).toBe(false));

    fireEvent.click(submit());

    await waitFor(() =>
      expect(screen.getByText("you cannot review this pull request")).toBeTruthy(),
    );
    expect(prEntry(ROOT, 42).pending).toHaveLength(1);
  });

  it("refuses a verdict on your own pull request, and says why on screen", async () => {
    // GitHub answers 422 for approve and request-changes from the author, and
    // on a single-owner repo that is every pull request. The verdict stays
    // pickable and the submit is what refuses: a control that vanishes says
    // nothing, and a disabled one with no visible reason reads as broken.
    await signIn();
    await pollWith();
    openTab();
    await waitFor(() => expect(screen.getByText(/skarif2/)).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: /Approve/ }));

    await waitFor(() => expect(submit().disabled).toBe(true));
    expect(document.querySelector("[data-submit-reason]")!.textContent).toContain(
      "does not accept this on your own pull request",
    );
  });

  it("renders a verdict the host does not have inert rather than absent", async () => {
    // A missing radio and a refused one are two different noes, and a missing
    // one says neither.
    bridge.capabilities = { ...FULL_CAPS, requestChanges: false };
    await signIn();
    await pollWith();
    openTab();
    await waitFor(() => expect(screen.getByText(/skarif2/)).toBeTruthy());

    await waitFor(() =>
      expect(
        (screen.getByRole("radio", { name: /Request changes/ }) as HTMLInputElement).disabled,
      ).toBe(true),
    );
    expect((screen.getByRole("radio", { name: /Comment/ }) as HTMLInputElement).disabled).toBe(
      false,
    );
  });
});
