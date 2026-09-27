import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../../test/axe";
import type { ForgeAccount, PrFile, PullRequest, ReviewThread, StatusReport } from "../../../utils/forgeTypes";

// One pull request file, read where there is room to read it.
//
// The tab exists because the panel's column is 320px and a diff is not a 320px
// document. What these tests pin is everything that follows from it being a tab
// rather than a section of the panel: it is opened by id and has to find its own
// file, it is one file so an outdated conversation has nowhere else to go, and
// the draft it holds has to survive the tab not being the one on screen.

/// A resize observer the test drives, because the width is the whole point of
/// one of these assertions: side-by-side is refused below `SIDE_BY_SIDE_MIN_WIDTH`,
/// and a stub that never reports leaves the pane at its initial `Infinity`,
/// where the narrow case can never be reached.
let paneWidth = 2000;
const observers: ((w: number) => void)[] = [];
globalThis.ResizeObserver = class {
  constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {
    observers.push((w) => this.cb([{ contentRect: { width: w } }]));
  }
  observe() {
    this.cb([{ contentRect: { width: paneWidth } }]);
  }
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ROOT = "/root/work/gh";
const BRANCH = "wave-3";
const SHA_A = "9f1c2a3b4d5e6f708192a3b4c5d6e7f809a1b2c3";
const SHA_B = "1122334455667788990011223344556677889900";
const RATE = { remaining: null, limit: null, resetAt: null };

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  files: [] as unknown[],
  threads: [] as unknown[],
  report: null as unknown,
  capabilities: {} as Record<string, boolean>,
  sessions: [] as unknown[],
  addFails: null as { kind: string; message: string } | null,
}));

/** The detail read, around the one field a test cares about. */
const summaryOf = (mergeableState: string) => ({
  mergeableState,
  updatedAt: "2026-09-18T11:02:00Z",
  counts: {
    commits: 2,
    changedFiles: 1,
    additions: 1,
    deletions: 1,
    reviews: { approved: 0, changesRequested: 0 },
  },
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "forge_pr_files") return Promise.resolve({ items: bridge.files, truncated: false });
    if (cmd === "forge_review_threads") return Promise.resolve({ items: bridge.threads, truncated: false });
    if (cmd === "forge_pr_summary") return Promise.resolve(summaryOf("clean"));
    if (cmd === "forge_unit_statuses") {
      return Promise.resolve(bridge.report ?? { statuses: [], uncovered: 0, rate: RATE });
    }
    if (cmd === "forge_add_review_comment") {
      return bridge.addFails ? Promise.reject(bridge.addFails) : Promise.resolve(null);
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
    if (cmd === "list_sessions") return Promise.resolve(bridge.sessions);
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

const { default: PrDiffView } = await import("./PrDiffView");
const { prDiffTabId, parseSyntheticId } = await import("../../../utils/syntheticTabs");
const {
  prEntry,
  isViewed,
  composerText,
  notePr,
  pendingFor,
  resetPrReviewStoreForTests,
} = await import("../../../utils/prReviewStore");
const {
  noteForgeAccounts,
  noteForgeEnabled,
  noteWatchedProjects,
  pollNow,
  resetForgeStatusForTests,
  resolveForgeRepo,
} = await import("../../../utils/forgeStatus");
const { noteForgeUnits, resetSessionActivityForTests } = await import("../../../utils/sessionActivity");

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
  number: 412,
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
  headSha: SHA_A,
  headRepoIsOrigin: true,
  url: "https://github.com/skarif2/tori/pull/412",
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

/** Let the poll cover this branch, which is where the tab reads the pull
 *  request itself from: it opens by number and fetches none of this. */
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

/** Mount the tab the way the stage does: from a `prdiff` id. */
function openTab(path = "src/edit.ts") {
  const id = prDiffTabId(ROOT, 412, path);
  const t = parseSyntheticId(id)!;
  return render(() => <PrDiffView workspace={t.workspace} arg={t.arg} />);
}

const rowFor = (text: string) =>
  Array.from(document.querySelectorAll("[class*=commentable]")).find((r) =>
    r.textContent?.includes(text),
  )!;

/** A diff row's text is split across spans by the word-level highlighting, so
 *  it is never one text node to query for. */
const seeRow = (text: string) => waitFor(() => expect(rowFor(text)).toBeTruthy());

describe("a pull request file as a tab in the stage", () => {
  beforeEach(async () => {
    bridge.calls.length = 0;
    paneWidth = 2000;
    observers.length = 0;
    bridge.files = [file(), file({ path: "src/other.ts", additions: 4, deletions: 0 })];
    bridge.threads = [];
    bridge.report = null;
    bridge.addFails = null;
    bridge.capabilities = { ...FULL_CAPS };
    bridge.sessions = [];
    localStorage.clear();
    resetPrReviewStoreForTests();
    resetForgeStatusForTests();
    resetSessionActivityForTests();
    await signIn();
    await pollWith();
  });

  it("renders the named file's hunks, having fetched the pull request once", async () => {
    openTab();
    await seeRow("+two edited");

    // The header says which file and where it sits, which a tab strip cannot.
    expect(screen.queryByText("edit.ts")).toBeTruthy();
    expect(screen.queryByText("file 1 of 2")).toBeTruthy();
    // One read for the whole pull request, however many of its files are open.
    expect(cmds("forge_pr_files")).toHaveLength(1);
  });

  it("renders a pull request the poll has never covered, once it has been told", async () => {
    // A pull request on a branch this machine has no unit for is one the poll
    // never asks about, and there is no read by number to fall back on. Without
    // a way to be told, the list tab would open a tab that renders "no pull
    // request here carries that number" over a diff it has in hand.
    resetForgeStatusForTests();
    await signIn();
    const orphan = openTab();
    await waitFor(() => expect(screen.queryByText(/No pull request here/)).toBeTruthy());
    orphan.unmount();

    notePr(ROOT, 412, pr());
    openTab();
    await seeRow("+two edited");
    expect(screen.queryByText("file 1 of 2")).toBeTruthy();
  });

  it("says so rather than showing another file when the id names nothing", async () => {
    openTab("src/deleted-since.ts");
    await waitFor(() =>
      expect(screen.queryByText(/not in the pull request's diff any more/)).toBeTruthy(),
    );
    // And emphatically not the first file's diff under the missing one's name.
    expect(rowFor("+two edited")).toBeUndefined();
  });

  it("opens the composer on the focused row when c is pressed", async () => {
    openTab();
    await seeRow("+two edited");

    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    // The anchor names the row it was opened on, not the file's first line.
    expect(box.getAttribute("aria-label")).toBe("Comment on src/edit.ts:2");
  });

  it("grows the anchor to a range when the second row is shift-clicked", async () => {
    bridge.files = [
      file({ patch: ["@@ -40,2 +40,4 @@", " forty", "+forty one", "+forty two"].join("\n") }),
    ];
    openTab();
    await seeRow("+forty one");

    fireEvent.click(rowFor("+forty one").querySelector("button")!);
    fireEvent.click(rowFor("+forty two").querySelector("button")!, { shiftKey: true });

    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    expect(box.getAttribute("aria-label")).toBe("Comment on src/edit.ts:41-42");
  });

  it("leaves a click on the code itself to select text and nothing else", async () => {
    openTab();
    await seeRow("+two edited");

    // The row, not its gutter affordance. Reading a diff involves clicking in
    // it constantly, and a composer that opens on every one of those is a
    // surface you cannot read.
    fireEvent.click(rowFor("+two edited"));
    expect(screen.queryByLabelText(/^Comment on /)).toBeNull();
  });

  it("keeps a half-typed comment when the composer closes and when the tab does", async () => {
    const first = openTab();
    await seeRow("+two edited");
    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    fireEvent.input(box, { target: { value: "half a thought" } });

    // Esc closes it. The words are not the composer's, they are the review's.
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText(/^Comment on /)).toBeNull());

    // And the tab going away is the same question asked harder: the stage
    // unmounts a synthetic view the moment it is not the active tab.
    first.unmount();
    openTab();
    await seeRow("+two edited");
    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    const again = await waitFor(() => screen.getByLabelText(/^Comment on /));
    expect((again as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("adds the comment to the draft on Cmd+Enter without posting it", async () => {
    openTab();
    await seeRow("+two edited");
    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    fireEvent.input(box, { target: { value: "this line" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });

    await waitFor(() => expect(prEntry(ROOT, 412).pending).toHaveLength(1));
    const held = prEntry(ROOT, 412).pending[0];
    expect(held).toMatchObject({ path: "src/edit.ts", line: 2, side: "RIGHT", body: "this line" });
    // The row it was written against travels with it, which is the only thing
    // that can later tell "still fits" from "now says something else".
    expect(held.rowText).toBe("+two edited");
    expect(cmds("forge_submit_review")).toHaveLength(0);
    expect(cmds("forge_add_review_comment")).toHaveLength(0);
    // And the composer it came from is empty, not still holding the text.
    expect(composerText(ROOT, 412, held)).toBe("");
    // The tab strip's mark reads this. Without it, a review written across four
    // files has three invisible thirds whenever one of them is on screen.
    expect(pendingFor(ROOT, 412, "src/edit.ts")).toBe(1);
    expect(pendingFor(ROOT, 412, "src/other.ts")).toBe(0);
  });

  it("puts an outdated conversation in the strip and on no row", async () => {
    // GitHub reports `isOutdated` with a line still on it, and that line
    // describes a version of the file that has moved on. This is one file, so
    // there is no pull-request-wide group to send it to: the strip or nowhere.
    bridge.threads = [
      thread({ id: "PRRT_stale", isOutdated: true, comments: [
        { id: "C2", author: "reviewer", body: "written against the old file", createdAt: "" },
      ] }),
    ];
    openTab();
    await waitFor(() => expect(screen.queryByText("written against the old file")).toBeTruthy());

    const strip = document.querySelector('[data-group="stranded"]')!;
    expect(strip.textContent).toContain("1 conversation is not on a line shown here");
    expect(strip.querySelector('[data-thread-id="PRRT_stale"]')).toBeTruthy();
    // Nowhere else, which is the half that matters: placed on line 2 it would
    // read as a remark about whatever occupies line 2 today.
    expect(document.querySelectorAll('[data-thread-id="PRRT_stale"]')).toHaveLength(1);
    // Above the first hunk, not after the last: a reader who scrolls a long
    // file and meets this at the bottom has already formed a view.
    const firstRow = document.querySelector("[class*=diffLine]")!;
    expect(strip.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("flips Viewed in the store rather than in the tab", async () => {
    openTab();
    await seeRow("+two edited");
    expect(isViewed(ROOT, 412, "src/edit.ts")).toBe(false);

    fireEvent.click(screen.getByLabelText("Viewed"));
    // In the store, so the panel's row and the overview's count agree with it
    // without either being told.
    expect(isViewed(ROOT, 412, "src/edit.ts")).toBe(true);
  });

  it("refuses side-by-side under the width it needs, and says why", async () => {
    // Two columns of code below 640px are two columns nobody can read, so the
    // control goes inert rather than honouring a preference into unreadability.
    // Disabled with its reason, never hidden: hidden would read as a build
    // without the feature.
    const toggle = () =>
      screen
        .getAllByRole("button")
        .find((b) => /side-by-side/i.test(b.getAttribute("aria-label") ?? ""))! as HTMLButtonElement;

    paneWidth = 400;
    const narrow = openTab();
    await seeRow("+two edited");
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute("aria-label")).toContain("needs a wider pane");
    narrow.unmount();

    paneWidth = 2000;
    openTab();
    await seeRow("+two edited");
    expect(toggle().disabled).toBe(false);
  });

  it("offers the file in this worktree only where the branch is checked out", async () => {
    openTab();
    await seeRow("+two edited");
    const named = (name: string) =>
      screen.queryAllByRole("button").some((b) => b.getAttribute("aria-label") === name);
    // Nothing has this branch checked out, so the head is a commit in the
    // object store and there is no file on disk to open.
    expect(named("Open the file in this worktree")).toBe(false);

    noteForgeUnits([
      {
        kind: "worktree",
        projectPath: ROOT,
        folderPath: `${ROOT}/wave-3`,
        branch: BRANCH,
        isCurrent: false,
        attention: false,
      },
    ]);
    await waitFor(() => expect(named("Open the file in this worktree")).toBe(true));
  });

  it("offers a reload when the head has moved, and re-reads only the files", async () => {
    openTab();
    await seeRow("+two edited");
    expect(screen.queryByText(/new commits since you read this/)).toBeNull();

    await pollWith(SHA_B);
    await waitFor(() => expect(screen.queryByText(/new commits since you read this/)).toBeTruthy());

    bridge.calls.length = 0;
    fireEvent.click(screen.getByText("Reload the diff"));
    await waitFor(() => expect(cmds("forge_pr_files")).toHaveLength(1));
    // Only the patches. The conversations and the verdict did not move.
    expect(cmds("forge_review_threads")).toHaveLength(0);
    expect(cmds("forge_pr_summary")).toHaveLength(0);
  });

  it("posts a single comment against the commit its patch came from", async () => {
    openTab();
    await seeRow("+two edited");
    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    fireEvent.input(box, { target: { value: "right now" } });

    fireEvent.click(screen.getByText("Add single comment"));
    await waitFor(() => expect(cmds("forge_add_review_comment")).toHaveLength(1));
    const sent = cmds("forge_add_review_comment")[0].args;
    expect(sent.number).toBe(412);
    // The sha the patches on screen were read at, not whatever the head is by
    // the time this arrives.
    expect(sent.commitId).toBe(SHA_A);
    expect(sent.comment).toMatchObject({ path: "src/edit.ts", line: 2, body: "right now" });
    // It is not a held comment: it went out on its own.
    expect(prEntry(ROOT, 412).pending).toHaveLength(0);
  });

  it("hides the single comment on a host without it, and disables it under drift", async () => {
    // The repo's capabilities are resolved once and cached, so the host has to
    // say so before anything resolves against it.
    bridge.capabilities = { ...FULL_CAPS, singleComment: false };
    resetForgeStatusForTests();
    await signIn();
    await pollWith();
    const first = openTab();
    await seeRow("+two edited");
    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    await waitFor(() => expect(screen.getByLabelText(/^Comment on /)).toBeTruthy());
    // Absent, not disabled: on GitLab there is no such call at all, and a greyed
    // button would say this pull request is the reason.
    expect(screen.queryByText("Add single comment")).toBeNull();
    first.unmount();

    bridge.capabilities = { ...FULL_CAPS };
    resetPrReviewStoreForTests();
    resetForgeStatusForTests();
    await signIn();
    await pollWith();
    openTab();
    await seeRow("+two edited");
    await pollWith(SHA_B);

    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    fireEvent.input(box, { target: { value: "right now" } });
    // Present and refused: this host has the call, and a comment carrying a
    // commit id the patch is no longer from is the one thing it must not send.
    const button = screen.getByText("Add single comment").closest("button")!;
    expect(button.disabled).toBe(true);
  });

  it("tells the three reasons a file shows no diff apart", async () => {
    bridge.files = [
      file({ path: "big.json", patch: null, additions: 3_000, deletions: 900 }),
      file({ path: "logo.png", patch: null, additions: 0, deletions: 0 }),
      file({ path: "to.ts", previousPath: "from.ts", status: "renamed", patch: null, additions: 0, deletions: 0 }),
    ];

    const big = openTab("big.json");
    await waitFor(() => expect(screen.queryByText("Diff too large to load")).toBeTruthy());
    // The only one where content is genuinely missing, so the only one that
    // spends the attention colour and the only one offering a way to it.
    expect(document.querySelector('[data-file-skip="tooLarge"]')).toBeTruthy();
    expect((screen.getByText("View on github.com") as HTMLAnchorElement).getAttribute("href")).toBe(
      "https://github.com/skarif2/tori/pull/412/files",
    );
    big.unmount();

    const png = openTab("logo.png");
    await waitFor(() => expect(screen.queryByText("Binary file, nothing to diff")).toBeTruthy());
    // The sizes are the whole of what a reader can learn about a changed PNG.
    await waitFor(() => expect(screen.queryByText(/24 KB before, 31 KB after/)).toBeTruthy());
    expect(screen.queryAllByText(/github.com/)).toHaveLength(0);
    png.unmount();

    openTab("to.ts");
    await waitFor(() => expect(screen.queryByText("Renamed, contents unchanged")).toBeTruthy());
    expect(screen.queryByText(/from.ts → to.ts/)).toBeTruthy();
    expect(screen.queryAllByText(/github.com/)).toHaveLength(0);
  });
});

describe("moving between a diff's conversations", () => {
  beforeEach(async () => {
    bridge.calls.length = 0;
    paneWidth = 2000;
    observers.length = 0;
    bridge.files = [
      file({ patch: ["@@ -1,5 +1,5 @@", " one", "-two", "+two edited", " three", " four", " five"].join("\n") }),
    ];
    bridge.threads = [
      thread({ id: "PRRT_a", line: 2 }),
      thread({ id: "PRRT_b", line: 4, comments: [{ id: "C2", author: "reviewer", body: "and this one", createdAt: "" }] }),
    ];
    bridge.report = null;
    bridge.addFails = null;
    bridge.capabilities = { ...FULL_CAPS };
    bridge.sessions = [];
    localStorage.clear();
    resetPrReviewStoreForTests();
    resetForgeStatusForTests();
    resetSessionActivityForTests();
    await signIn();
    await pollWith();
  });

  const cards = () => [...document.querySelectorAll<HTMLElement>("[data-thread-id]")];
  const pane = () => document.querySelector<HTMLElement>("[class*=prDiff]")!;

  it("steps through them on n and p, and stops at both ends", async () => {
    openTab();
    await waitFor(() => expect(cards()).toHaveLength(2));

    // Focusable without being a tab stop: a card per conversation in the Tab
    // order would put a stop in front of every reply box in a long diff.
    expect(cards()[0].getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(pane(), { key: "n" });
    expect(document.activeElement).toBe(cards()[0]);
    fireEvent.keyDown(pane(), { key: "n" });
    expect(document.activeElement).toBe(cards()[1]);
    // The end of the conversations is a fact worth arriving at, so it clamps.
    fireEvent.keyDown(pane(), { key: "n" });
    expect(document.activeElement).toBe(cards()[1]);
    fireEvent.keyDown(pane(), { key: "p" });
    expect(document.activeElement).toBe(cards()[0]);
  });

  it("has an accessible name for everything the tab draws in colour or a glyph", async () => {
    // The header's icon buttons, the Viewed checkbox, the drift strip, the
    // conversations and the composer, all at once: axe over the tab rather than
    // over its body, which `PrFileBody.test.tsx` already covers.
    openTab();
    await waitFor(() => expect(cards()).toHaveLength(2));
    // The head moving after the patches were read is what puts the drift strip
    // on screen, so the poll has to land second.
    await pollWith(SHA_B);
    await waitFor(() => expect(screen.queryByText(/new commits since you read this/)).toBeTruthy());
    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    await waitFor(() => expect(screen.getByLabelText(/^Comment on /)).toBeTruthy());

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });

  it("leaves the letters alone inside the composer", async () => {
    openTab();
    await waitFor(() => expect(cards()).toHaveLength(2));

    // A comment with the word "not" in it is the whole reason this guard is
    // here: `n` typed into text is text, so the composer keeps both the key and
    // the focus.
    fireEvent.keyDown(rowFor("+two edited"), { key: "c" });
    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.keyDown(box, { key: "n" });
    expect(document.activeElement).toBe(box);

    // And a modifier says the key was aimed at the app, not at this diff.
    fireEvent.keyDown(pane(), { key: "n", metaKey: true });
    expect(document.activeElement).toBe(box);
  });
});
