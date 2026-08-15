import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../../test/axe";
import { pointerClick } from "../../../test/menus";
import { createSignal } from "solid-js";
import type { PrFile, PullRequest, ReviewThread } from "../../../utils/forgeTypes";

// One pull request's files.
//
// The two things this view exists to get right, neither of which a
// working-looking panel would show:
//
//   1. **The patch is GitHub's, not one Sway computed.** A local `git diff` of
//      the same two commits reads identically and anchors differently, and
//      Phase 10's review threads are measured against the anchors GitHub used.
//   2. **The unchanged regions are git's, not the API's.** Expanding a gap is
//      free, works on a head that was never checked out, and must never read the
//      file on disk: the right line numbers over the wrong content is the one
//      failure that looks exactly like an answer.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ROOT = "/root/work/gh";
const HEAD_SHA = "9f1c2a3b4d5e6f708192a3b4c5d6e7f809a1b2c3";

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: "Let a pull request be read in place",
  body: null,
  state: "open",
  isDraft: false,
  author: "skarif2",
  headRef: "wave-3",
  baseRef: "main",
  headSha: HEAD_SHA,
  url: "https://github.com/skarif2/sway/pull/42",
  mergeableState: "clean",
  ...over,
});

const file = (over: Partial<PrFile> = {}): PrFile => ({
  path: "src/utils/forgeChip.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
  ...over,
});

// The second hunk here ends in two consecutive additions, which is the only
// shape a same-side multi-line range can be built from: context rows are not
// selectable, so a range needs two changed rows counted in one numbering.
const RANGEABLE = [
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+two edited",
  " three",
  "@@ -40,2 +40,4 @@",
  " forty",
  "-forty one",
  "+forty one edited",
  "+forty two added",
  "+forty three added",
].join("\n");

// Two hunks with 36 untouched lines between them, which is what makes a gap.
const TWO_HUNKS = [
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+two edited",
  " three",
  "@@ -40,3 +40,3 @@",
  " forty",
  "-forty one",
  "+forty one edited",
  " forty two",
].join("\n");

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  files: [] as unknown[],
  truncated: false,
  fail: null as { kind: string; message: string } | null,
  slice: [] as string[],
  fetchFails: null as string | null,
  sliceFails: null as string | null,
  threads: [] as unknown[],
  threadsTruncated: false,
  threadsFail: null as { kind: string; message: string } | null,
  reply: null as unknown,
  replyFails: null as { kind: string; message: string } | null,
  resolveFails: null as { kind: string; message: string } | null,
  viewer: null as string | null,
  submitFails: null as { kind: string; message: string } | null,
  mergeable: "clean" as string,
  mergeableFails: null as { kind: string; message: string } | null,
  mergeFails: null as { kind: string; message: string } | null,
  updateFails: null as { kind: string; message: string } | null,
  sessions: [] as unknown[],
  running: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "github_pr_files") {
      return bridge.fail
        ? Promise.reject(bridge.fail)
        : Promise.resolve({ items: bridge.files, truncated: bridge.truncated });
    }
    if (cmd === "git_fetch_pr_head")
      return bridge.fetchFails ? Promise.reject(bridge.fetchFails) : Promise.resolve(null);
    if (cmd === "git_blob_slice")
      return bridge.sliceFails ? Promise.reject(bridge.sliceFails) : Promise.resolve(bridge.slice);
    if (cmd === "github_review_threads") {
      return bridge.threadsFail
        ? Promise.reject(bridge.threadsFail)
        : Promise.resolve({ items: bridge.threads, truncated: bridge.threadsTruncated });
    }
    if (cmd === "github_reply_to_thread")
      return bridge.replyFails ? Promise.reject(bridge.replyFails) : Promise.resolve(bridge.reply);
    if (cmd === "github_set_thread_resolved")
      return bridge.resolveFails ? Promise.reject(bridge.resolveFails) : Promise.resolve(null);
    if (cmd === "github_viewer")
      return bridge.viewer ? Promise.resolve(bridge.viewer) : Promise.reject(new Error("signed out"));
    if (cmd === "github_submit_review")
      return bridge.submitFails ? Promise.reject(bridge.submitFails) : Promise.resolve(null);
    if (cmd === "github_mergeability")
      return bridge.mergeableFails
        ? Promise.reject(bridge.mergeableFails)
        : Promise.resolve(bridge.mergeable);
    if (cmd === "github_merge")
      return bridge.mergeFails ? Promise.reject(bridge.mergeFails) : Promise.resolve(null);
    if (cmd === "github_update_branch")
      return bridge.updateFails ? Promise.reject(bridge.updateFails) : Promise.resolve(null);
    if (cmd === "list_sessions") return Promise.resolve(bridge.sessions);
    if (cmd === "sessions_running") return Promise.resolve(bridge.running);
    if (cmd === "github_auth_state")
      return Promise.resolve(
        bridge.viewer ? { kind: "signedIn", login: bridge.viewer } : { kind: "signedOut" },
      );
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));

const { default: PrDetail } = await import("./PrDetail");
const { noteForgeAuth, noteForgeEnabled, resetForgeStatusForTests } = await import(
  "../../../utils/forgeStatus"
);
const { noteForgeUnits, probeBatch, resetSessionActivityForTests } = await import(
  "../../../utils/sessionActivity"
);
const { trackFolders, resetSessionStoreForTests } = await import("../../../utils/sessionStore");
const { onWith, emitWith, SEND_TO_SESSION, SEND_TO_SESSION_RESULT, REMOVE_BRANCH_UNIT } =
  await import("../../../utils/events");
type RemoveBranchUnit = { projectPath: string; branch: string };

const cmds = (name: string) => bridge.calls.filter((c) => c.cmd === name);

/** Sign in as `login`, and let the viewer identity land. */
const signInAs = async (login: string) => {
  bridge.viewer = login;
  noteForgeEnabled(true);
  noteForgeAuth({ kind: "signedIn", login });
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("the pull request detail", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.files = [];
    bridge.truncated = false;
    bridge.fail = null;
    bridge.slice = [];
    bridge.fetchFails = null;
    bridge.sliceFails = null;
    bridge.threads = [];
    bridge.threadsTruncated = false;
    bridge.threadsFail = null;
    bridge.reply = null;
    bridge.replyFails = null;
    bridge.resolveFails = null;
    localStorage.clear();
  });

  it("renders every kind of change the API reports", async () => {
    // Four statuses, four different rows. The rename is the one that cannot be
    // inferred: without `previousPath` it reads as a new file beside a deleted
    // one, which is two changes where there was one.
    bridge.files = [
      file({ path: "src/new.ts", status: "added", additions: 9, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+const a = 1;" }),
      file({ path: "src/gone.ts", status: "removed", additions: 0, deletions: 4, patch: "@@ -1,1 +0,0 @@\n-const b = 2;" }),
      file({ path: "src/edit.ts", status: "modified" }),
      file({
        path: "src/to.ts",
        previousPath: "src/from.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: null,
      }),
    ];

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);

    await waitFor(() => expect(screen.queryByText("src/new.ts")).toBeTruthy());
    expect(screen.queryByText("src/gone.ts")).toBeTruthy();
    expect(screen.queryByText("src/edit.ts")).toBeTruthy();
    // Both halves of the rename, in one row.
    expect(screen.queryByText("src/from.ts → src/to.ts")).toBeTruthy();

    const statuses = Array.from(document.querySelectorAll("[data-file-status]")).map(
      (n) => n.getAttribute("data-file-status"),
    );
    expect(statuses).toEqual(["added", "removed", "modified", "renamed"]);

    // The patch on screen is the API's own text, byte for byte: it is what
    // Phase 10's thread anchors are measured against.
    fireEvent.click(screen.getByText("src/edit.ts"));
    expect(screen.queryByText("@@ -1,1 +1,1 @@")).toBeTruthy();
    // By `textContent`, not by text node: a matched -/+ pair is split into
    // word-level segments so the one changed token can be highlighted.
    expect(document.body.textContent).toContain("+const a = 2;");
    expect(document.body.textContent).toContain("-const a = 1;");
  });

  it("lists all forty files of a forty-file pull request", async () => {
    // The API pages at 100 and Rust walks to the ceiling; what this pins is that
    // the view renders what came back rather than slicing it to something that
    // fits on screen.
    bridge.files = Array.from({ length: 40 }, (_, i) => file({ path: `src/f${i}.ts` }));

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);

    await waitFor(() => expect(screen.queryByText("src/f0.ts")).toBeTruthy());
    expect(document.querySelectorAll("[data-file-status]")).toHaveLength(40);
    expect(screen.queryByText("src/f39.ts")).toBeTruthy();
  });

  it("expands a gap from the pull request's own head, spending no API quota", async () => {
    // The head is not checked out here, which is the normal case for reviewing
    // somebody's PR. The lines come from the commit, over git, and the request
    // count for the whole expansion is zero.
    bridge.files = [file({ path: "src/edit.ts", patch: TWO_HUNKS })];
    bridge.slice = ["line four", "line five"];

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(screen.queryByText("src/edit.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("src/edit.ts"));

    const gap = screen.getByText(/36 unchanged lines/);
    // After the reads that opening a pull request makes (the files, the threads
    // and the mergeability verdict), so this counts what *expanding* costs
    // rather than what arriving costs.
    await waitFor(() => expect(cmds("github_mergeability")).toHaveLength(1));
    const before = bridge.calls.length;
    fireEvent.click(gap);

    await waitFor(() => expect(screen.queryByText("line four")).toBeTruthy());
    expect(screen.queryByText("line five")).toBeTruthy();

    // The two halves of the promise. Nothing since the click touched the API,
    // and the content was read at the PR's head sha rather than off disk.
    const since = bridge.calls.slice(before);
    expect(since.filter((c) => c.cmd.startsWith("github_"))).toHaveLength(0);
    expect(cmds("git_fetch_pr_head")[0].args).toMatchObject({ number: 42, sha: HEAD_SHA });
    expect(cmds("git_blob_slice")[0].args).toMatchObject({
      rev: HEAD_SHA,
      file: "src/edit.ts",
      start: 4,
      end: 39,
    });
  });

  it("fetches the head once, however many gaps are opened", async () => {
    // A fetch per expansion would put a network round trip behind every click
    // on a file the object store already holds in full.
    bridge.files = [
      file({ path: "a.ts", patch: TWO_HUNKS }),
      file({ path: "b.ts", patch: TWO_HUNKS }),
    ];
    bridge.slice = ["line four"];

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(screen.queryByText("a.ts")).toBeTruthy());

    for (const path of ["a.ts", "b.ts"]) {
      fireEvent.click(screen.getByText(path));
      fireEvent.click(screen.getByText(/36 unchanged lines/));
      await waitFor(() => expect(cmds("git_blob_slice").some((c) => c.args.file === path)).toBe(true));
      fireEvent.click(screen.getByText(path));
    }
    expect(cmds("git_fetch_pr_head")).toHaveLength(1);
  });

  it("keeps the fetched head when it is the read that failed", async () => {
    // Two different failures, one cache. Forgetting the fetch because a read of
    // one path failed sends the next expansion back to the network for a commit
    // that arrived perfectly well.
    bridge.files = [file({ path: "a.ts", patch: TWO_HUNKS })];
    bridge.sliceFails = "path does not exist in 9f1c2a3";

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(screen.queryByText("a.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("a.ts"));
    fireEvent.click(screen.getByText(/36 unchanged lines/));
    await waitFor(() => expect(screen.queryByText(/path does not exist/)).toBeTruthy());

    bridge.sliceFails = null;
    bridge.slice = ["line four"];
    fireEvent.click(screen.getByText(/36 unchanged lines/));
    await waitFor(() => expect(screen.queryByText("line four")).toBeTruthy());
    expect(cmds("git_fetch_pr_head")).toHaveLength(1);
  });

  it("says so when a gap cannot be read rather than doing nothing visible", async () => {
    // A PR ref the remote will not serve, or no network at all. A click that
    // silently fails is indistinguishable from a click that missed.
    bridge.files = [file({ path: "src/edit.ts", patch: TWO_HUNKS })];
    bridge.fetchFails = "could not read from remote repository";

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(screen.queryByText("src/edit.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("src/edit.ts"));
    fireEvent.click(screen.getByText(/36 unchanged lines/));

    await waitFor(() =>
      expect(screen.queryByText(/could not read from remote repository/)).toBeTruthy(),
    );
    // And the gap stayed shut, rather than opening onto nothing.
    expect(screen.queryByText(/36 unchanged lines/)).toBeTruthy();
  });

  it("tells the three reasons a file shows no diff apart", async () => {
    // All three arrive as `patch: null`, and only one of them means content is
    // missing. Rendering "no changes to show" over a 4,000-line file is the
    // failure that reads as a working diff.
    bridge.files = [
      file({ path: "big.json", patch: null, additions: 3_000, deletions: 900 }),
      file({ path: "logo.png", patch: null, additions: 0, deletions: 0 }),
      file({ path: "to.ts", previousPath: "from.ts", status: "renamed", patch: null, additions: 0, deletions: 0 }),
    ];

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(screen.queryByText("big.json")).toBeTruthy());

    fireEvent.click(screen.getByText("big.json"));
    expect(document.querySelector('[data-file-skip="tooLarge"]')).toBeTruthy();
    expect(screen.queryByText(/larger than the API will send/)).toBeTruthy();
    // The one skip where content is genuinely missing is the one that offers a
    // way to the content.
    const out = screen.getByText(/Read it on github.com/) as HTMLAnchorElement;
    expect(out.getAttribute("href")).toBe("https://github.com/skarif2/sway/pull/42/files");

    fireEvent.click(screen.getByText("logo.png"));
    expect(document.querySelector('[data-file-skip="noText"]')).toBeTruthy();

    fireEvent.click(screen.getByText("from.ts → to.ts"));
    expect(document.querySelector('[data-file-skip="moved"]')).toBeTruthy();
    // And the two that are complete as they stand offer none: a link out would
    // imply the reader is missing something.
    expect(screen.queryAllByText(/on github.com/)).toHaveLength(0);
  });

  it("sends the reader to github.com when the file list is capped", async () => {
    // GitHub's own ceiling, not a budget of ours. Past it the server stops
    // describing the PR, so a shorter list that looks whole is the one thing
    // this must not render.
    bridge.files = [file()];
    bridge.truncated = true;

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() =>
      expect(screen.queryByText(/more files than the API will describe/)).toBeTruthy(),
    );
    const link = screen.getByText(/See all of them on github.com/) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/skarif2/sway/pull/42/files");
  });

  it("shows the server's own sentence when the files cannot be fetched", async () => {
    bridge.fail = { kind: "rateLimited", message: "the GitHub rate limit is spent" };

    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(screen.queryByText("the GitHub rate limit is spent")).toBeTruthy());
  });

  it("drops one pull request's files when another is opened", async () => {
    // The panel reuses this component rather than remounting it, so a slow
    // answer can land after the one that replaced it and put one PR's files
    // under another's number.
    bridge.files = [file({ path: "first.ts" })];
    const [current, setCurrent] = createSignal(pr({ number: 1 }));
    render(() => <PrDetail root={ROOT} pr={current()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(screen.queryByText("first.ts")).toBeTruthy());

    bridge.files = [file({ path: "second.ts" })];
    setCurrent(pr({ number: 2 }));
    await waitFor(() => expect(screen.queryByText("second.ts")).toBeTruthy());
    expect(screen.queryByText("first.ts")).toBeNull();
  });
});

// Review conversations, on the diff they were written about.
describe("review threads on a pull request's diff", () => {
  beforeEach(() => {
    bridge.calls.length = 0;
    bridge.files = [file({ path: "src/edit.ts", patch: TWO_HUNKS })];
    bridge.truncated = false;
    bridge.fail = null;
    bridge.slice = [];
    bridge.fetchFails = null;
    bridge.sliceFails = null;
    bridge.threads = [];
    bridge.threadsTruncated = false;
    bridge.threadsFail = null;
    bridge.reply = null;
    bridge.replyFails = null;
    bridge.resolveFails = null;
    localStorage.clear();
  });

  // The path is on the file row *and* in every thread card's header, so the row
  // is reached by its status word rather than by its text.
  const open = async () => {
    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(document.querySelector("[data-file-status]")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-file-status]")!);
  };

  // The hunks of TWO_HUNKS cover new-side lines 1..3 and 40..42.
  const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
    id: "PRRT_1",
    path: "src/edit.ts",
    line: 2,
    startLine: null,
    diffHunk: "@@ -1,3 +1,3 @@\n one\n-two\n+two edited",
    isResolved: false,
    isOutdated: false,
    comments: [
      { id: "C1", author: "reviewer", body: "this drops the error", createdAt: "2026-08-03T09:00:00Z" },
    ],
    ...over,
  });

  it("puts a thread on its own line, inside the hunk it belongs to", async () => {
    bridge.threads = [thread({ line: 2 })];
    await open();

    await waitFor(() => expect(screen.queryByText("this drops the error")).toBeTruthy());
    const card = document.querySelector('[data-thread-id="PRRT_1"]')!;
    // The card sits after the row for line 2 and before the row for line 3,
    // which is what "anchored to a line" means in a rendered diff.
    const rows = Array.from(document.querySelectorAll("[class*=diffLine]"));
    const before = rows.filter((r) => r.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before[before.length - 1].textContent).toContain("+two edited");
  });

  it("sends an outdated thread to its own group, never to a line", async () => {
    // The mistake worth preventing: GitHub reports `isOutdated` with a line
    // still on it, and that line describes a version of the file that has moved
    // on. Placing it puts a three-week-old remark beside whatever occupies the
    // line today, which reads as a remark about it.
    bridge.threads = [
      thread({ id: "PRRT_current", line: 2 }),
      thread({ id: "PRRT_stale", line: 2, isOutdated: true, comments: [
        { id: "C2", author: "reviewer", body: "written against the old file", createdAt: "" },
      ] }),
      thread({ id: "PRRT_noline", line: null, comments: [
        { id: "C3", author: "reviewer", body: "no line at all", createdAt: "" },
      ] }),
    ];
    await open();

    await waitFor(() => expect(screen.queryByText("written against the old file")).toBeTruthy());
    const group = document.querySelector('[data-group="outdated"]')!;
    expect(group.querySelectorAll("[data-thread-id]")).toHaveLength(2);
    expect(group.querySelector('[data-thread-id="PRRT_current"]')).toBeNull();
    // And both outdated ones quote the hunk they were written against, which
    // with no line to sit beside is the whole of what makes them readable.
    expect(group.textContent).toContain("@@ -1,3 +1,3 @@");
  });

  it("holds back a thread anchored outside the lines this patch renders", async () => {
    // Current and correct, and on no row: line 20 sits in the stretch between
    // the two hunks. Dropping it silently is how a conversation disappears from
    // a file that visibly has one.
    bridge.threads = [
      thread({ id: "PRRT_off", line: 20, comments: [
        { id: "C9", author: "reviewer", body: "in the gap", createdAt: "" },
      ] }),
    ];
    await open();

    await waitFor(() => expect(screen.queryByText("in the gap")).toBeTruthy());
    expect(screen.queryByText(/Not on a line this diff shows/)).toBeTruthy();
    // Not in the outdated group either: it is not outdated, it is just not here.
    expect(document.querySelector('[data-group="outdated"]')).toBeNull();
  });

  it("shows a reply at once and then replaces it with what the server stored", async () => {
    bridge.threads = [thread()];
    bridge.reply = {
      id: "PRRC_stored",
      author: "skarif2",
      body: "fixed in 4d95fc3",
      createdAt: "2026-08-03T10:00:00Z",
    };
    await open();
    await waitFor(() => expect(screen.queryByText("this drops the error")).toBeTruthy());

    fireEvent.click(screen.getByText("Reply"));
    const box = screen.getByLabelText(/Reply to the thread on src\/edit.ts/) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "fixed in 4d95fc3" } });
    const buttons = screen.getAllByText("Reply");
    fireEvent.click(buttons[buttons.length - 1]);

    // Optimistic: on screen before the round trip, and visibly not stored yet.
    expect(screen.queryByText("fixed in 4d95fc3")).toBeTruthy();
    expect(document.querySelector('[data-pending="yes"]')).toBeTruthy();

    // Reconciled: the same one comment, now wearing the server's author. Scoped
    // to the card, since the pull request's own author is on screen too.
    await waitFor(() => expect(document.querySelector('[data-pending="yes"]')).toBeNull());
    expect(screen.queryAllByText("fixed in 4d95fc3")).toHaveLength(1);
    const card = document.querySelector('[data-thread-id="PRRT_1"]')!;
    expect(card.textContent).toContain("skarif2");
    expect(cmds("github_reply_to_thread")[0].args).toMatchObject({
      projectPath: ROOT,
      threadId: "PRRT_1",
      body: "fixed in 4d95fc3",
    });
  });

  it("takes a refused reply back off the screen", async () => {
    // A reply left standing after a refusal is a comment only its author can
    // see, and they have no way to tell.
    bridge.threads = [thread()];
    bridge.replyFails = { kind: "forbidden", message: "you cannot comment on this pull request" };
    await open();
    await waitFor(() => expect(screen.queryByText("this drops the error")).toBeTruthy());

    fireEvent.click(screen.getByText("Reply"));
    fireEvent.input(screen.getByLabelText(/Reply to the thread/), { target: { value: "nope" } });
    const buttons = screen.getAllByText("Reply");
    fireEvent.click(buttons[buttons.length - 1]);
    expect(screen.queryByText("nope")).toBeTruthy();

    await waitFor(() =>
      expect(screen.queryByText("you cannot comment on this pull request")).toBeTruthy(),
    );
    expect(screen.queryByText("nope")).toBeNull();
  });

  it("resolves and unresolves through one command with a flag", async () => {
    bridge.threads = [thread()];
    await open();
    await waitFor(() => expect(screen.queryByText("Resolve")).toBeTruthy());

    fireEvent.click(screen.getByText("Resolve"));
    await waitFor(() => expect(screen.queryByText("Unresolve")).toBeTruthy());
    fireEvent.click(screen.getByText("Unresolve"));
    await waitFor(() => expect(screen.queryByText("Resolve")).toBeTruthy());

    // Same call, same node id, opposite flag: they are one intent, and a
    // provider that has one has the other.
    const calls = cmds("github_set_thread_resolved").map((c) => c.args);
    expect(calls).toEqual([
      { projectPath: ROOT, threadId: "PRRT_1", resolved: true },
      { projectPath: ROOT, threadId: "PRRT_1", resolved: false },
    ]);
  });

  it("leaves a thread unresolved when the server refuses", async () => {
    // Not optimistic on purpose: a card that flips and flips back reads as a
    // click that did the opposite of what it said.
    bridge.threads = [thread()];
    bridge.resolveFails = { kind: "forbidden", message: "no write access" };
    await open();
    await waitFor(() => expect(screen.queryByText("Resolve")).toBeTruthy());

    fireEvent.click(screen.getByText("Resolve"));
    await waitFor(() => expect(screen.queryByText("no write access")).toBeTruthy());
    expect(screen.queryByText("Resolve")).toBeTruthy();
    expect(screen.queryByText("Unresolve")).toBeNull();
  });

  it("keeps the diff readable when the conversations cannot be read", async () => {
    // Two requests, two failures. A pull request whose threads will not load is
    // still a pull request worth reading.
    bridge.threadsFail = { kind: "rateLimited", message: "the GitHub rate limit is spent" };
    await open();

    await waitFor(() => expect(screen.queryByText("the GitHub rate limit is spent")).toBeTruthy());
    expect(screen.queryByText("@@ -1,3 +1,3 @@")).toBeTruthy();
  });

  it("says so when not every conversation could be read", async () => {
    // Same shape as every other cap here: a partial answer rendered as a
    // complete one is the failure nobody reports, because the page looks fine.
    bridge.threads = [thread()];
    bridge.threadsTruncated = true;
    await open();

    await waitFor(() =>
      expect(screen.queryByText(/more conversations than one read can carry/)).toBeTruthy(),
    );
    const link = screen.getByText(/See them all on github.com/) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/skarif2/sway/pull/42");
  });

  it("puts the cursor in the reply box when it opens", async () => {
    // A box that opens looking ready and needs a second click is worse than one
    // that does not open. `autofocus` is honoured inconsistently on an element
    // inserted this long after load, so the focus is taken by hand.
    bridge.threads = [thread()];
    await open();
    await waitFor(() => expect(screen.queryByText("Reply")).toBeTruthy());

    fireEvent.click(screen.getByText("Reply"));
    const box = screen.getByLabelText(/Reply to the thread on src\/edit.ts/);
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it("counts a closed file's conversations on its row", async () => {
    // A closed file with a conversation in it is otherwise indistinguishable
    // from one with none.
    bridge.threads = [thread({ id: "A", line: 2 }), thread({ id: "B", line: 41 })];
    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(document.querySelector("[data-thread-count]")).toBeTruthy());
    expect(document.querySelector("[data-thread-count]")!.getAttribute("data-thread-count")).toBe("2");
  });
});

// A review written across the diff and submitted in one call.
//
// The failure this shape prevents: posting comments as they are written and the
// verdict at the end leaves a half-submitted review behind whenever the last
// call fails, with nothing saying which comments already landed.
describe("writing and submitting a review", () => {
  beforeEach(async () => {
    resetForgeStatusForTests();
    bridge.calls.length = 0;
    bridge.files = [file({ path: "src/edit.ts", patch: TWO_HUNKS })];
    bridge.truncated = false;
    bridge.fail = null;
    bridge.slice = [];
    bridge.fetchFails = null;
    bridge.sliceFails = null;
    bridge.threads = [];
    bridge.threadsTruncated = false;
    bridge.threadsFail = null;
    bridge.reply = null;
    bridge.replyFails = null;
    bridge.resolveFails = null;
    bridge.viewer = null;
    bridge.submitFails = null;
    localStorage.clear();
  });

  const openDiff = async (author = "skarif2") => {
    render(() => <PrDetail root={ROOT} pr={pr({ author })} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(document.querySelector("[data-file-status]")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-file-status]")!);
  };

  /** Open the diff and start a review, which is what makes lines pickable. */
  const startReview = async (author = "skarif2") => {
    await openDiff(author);
    fireEvent.click(screen.getByText("Review"));
  };

  /** Pick diff rows by their text and write a line comment on them. */
  const commentOn = async (rowTexts: string[], body: string) => {
    const rows = Array.from(document.querySelectorAll('[role="checkbox"]'));
    for (const text of rowTexts) {
      const row = rows.find((r) => r.textContent?.includes(text));
      expect(row, `no selectable row for ${text}`).toBeTruthy();
      fireEvent.click(row!);
    }
    const box = await waitFor(() => screen.getByLabelText(/^Comment on /));
    fireEvent.input(box, { target: { value: body } });
    fireEvent.click(screen.getByText("Add to review"));
  };

  it("holds three comments, one of them a multi-line range, and posts nothing", async () => {
    bridge.files = [file({ path: "src/edit.ts", patch: RANGEABLE })];
    await signInAs("skarif2");
    await startReview();

    await commentOn(["+two edited"], "first");
    await commentOn(["-forty one"], "second");
    // A range needs two rows on the *same* side, and only changed rows can be
    // picked, so it takes two consecutive additions.
    await commentOn(["+forty two added", "+forty three added"], "third");

    const bar = document.querySelector("[data-pending-count]")!;
    expect(bar.getAttribute("data-pending-count")).toBe("3");
    // Each carries its own line and side, and the range carries both ends.
    const anchors = Array.from(document.querySelectorAll("[data-pending-comment]")).map((n) =>
      n.getAttribute("data-pending-comment"),
    );
    expect(anchors).toEqual([
      "src/edit.ts:2",
      "src/edit.ts:41 (base)",
      "src/edit.ts:42-43",
    ]);
    // And the whole point: nothing has been sent.
    expect(cmds("github_submit_review")).toHaveLength(0);
  });

  it("disables both verdicts on your own pull request, with the reason on screen", async () => {
    // GitHub answers 422 for approve and request-changes from the author, and
    // on a single-owner repo that is every pull request. Hiding the buttons
    // would make this look like a build without the feature.
    await signInAs("skarif2");
    await startReview("skarif2");
    await commentOn(["+two edited"], "a note");

    const button = (label: string) =>
      screen.getAllByText(label).find((n) => n.closest("button"))!.closest("button")!;
    expect(button("Approve").disabled).toBe(true);
    expect(button("Request changes").disabled).toBe(true);
    expect(button("Comment").disabled).toBe(false);
    expect(document.querySelector("[data-verdict-reason]")!.textContent).toContain(
      "does not accept this on your own pull request",
    );

    // And the one verb the author can use goes through, carrying the comments.
    fireEvent.click(button("Comment"));
    await waitFor(() => expect(cmds("github_submit_review")).toHaveLength(1));
    expect(cmds("github_submit_review")[0].args).toMatchObject({
      projectPath: ROOT,
      number: 42,
      event: "comment",
    });
    const sent = cmds("github_submit_review")[0].args.comments as unknown[];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: "src/edit.ts", line: 2, side: "RIGHT", body: "a note" });
  });

  it("offers both verdicts on somebody else's pull request", async () => {
    await signInAs("skarif2");
    await startReview("someone-else");
    await commentOn(["+two edited"], "a note");

    const button = (label: string) =>
      screen.getAllByText(label).find((n) => n.closest("button"))!.closest("button")!;
    expect(button("Approve").disabled).toBe(false);
    // The reason line may still speak for request-changes (no summary yet), but
    // never for authorship.
    expect(document.querySelector("[data-verdict-reason]")?.textContent ?? "").not.toContain(
      "your own pull request",
    );

    fireEvent.click(button("Approve"));
    await waitFor(() => expect(cmds("github_submit_review")).toHaveLength(1));
    expect(cmds("github_submit_review")[0].args).toMatchObject({ event: "approve" });
  });

  it("blocks request-changes until the review says what to change", async () => {
    // The server accepts a bare "changes requested". A reader receiving one with
    // no word about what to change cannot act on it.
    await signInAs("skarif2");
    await startReview("someone-else");
    await commentOn(["+two edited"], "a note");

    const button = (label: string) =>
      screen.getAllByText(label).find((n) => n.closest("button"))!.closest("button")!;
    expect(button("Request changes").disabled).toBe(true);
    expect(document.querySelector("[data-verdict-reason]")!.textContent).toContain(
      "needs a summary saying what to change",
    );

    fireEvent.input(screen.getByLabelText("Review summary"), {
      target: { value: "the error is dropped here" },
    });
    await waitFor(() => expect(button("Request changes").disabled).toBe(false));
  });

  it("clears the pending set on a successful submit and keeps it on a refusal", async () => {
    // A reader who loses every comment they wrote to one refusal will not write
    // them again.
    await signInAs("skarif2");
    await startReview("someone-else");
    await commentOn(["+two edited"], "a note");
    bridge.submitFails = { kind: "forbidden", message: "you cannot review this pull request" };

    const button = (label: string) =>
      screen.getAllByText(label).find((n) => n.closest("button"))!.closest("button")!;
    fireEvent.click(button("Comment"));
    await waitFor(() =>
      expect(screen.queryByText("you cannot review this pull request")).toBeTruthy(),
    );
    expect(document.querySelector("[data-pending-count]")!.getAttribute("data-pending-count")).toBe(
      "1",
    );

    bridge.submitFails = null;
    fireEvent.click(button("Comment"));
    await waitFor(() => expect(document.querySelector("[data-pending-count]")).toBeNull());
  });

  it("keeps both verdicts shut while it does not know who you are", async () => {
    // Not-yet-known is not known-different. Offering approve here ships a button
    // whose only outcome is a 422.
    await startReview("someone-else");
    await commentOn(["+two edited"], "a note");

    const button = (label: string) =>
      screen.getAllByText(label).find((n) => n.closest("button"))!.closest("button")!;
    expect(button("Approve").disabled).toBe(true);
    expect(button("Comment").disabled).toBe(false);
  });
});

describe("reading without reviewing", () => {
  beforeEach(() => {
    resetForgeStatusForTests();
    bridge.calls.length = 0;
    bridge.files = [file({ path: "src/edit.ts", patch: TWO_HUNKS })];
    bridge.threads = [];
    bridge.threadsFail = null;
    bridge.fail = null;
    bridge.viewer = null;
    localStorage.clear();
  });

  it("leaves the diff inert until a review is started", async () => {
    // `DiffRows` gives every selectable line a role, a tab stop and a click
    // handler, and its own source says why a read-only diff must not have them:
    // a five-thousand-line pull request would put five thousand controls in the
    // tab order, and lines would answer clicks that mean nothing.
    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(document.querySelector("[data-file-status]")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-file-status]")!);

    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0);

    fireEvent.click(screen.getByText("Review"));
    expect(document.querySelectorAll('[role="checkbox"]').length).toBeGreaterThan(0);
  });
});

describe("handing a review thread to the agent that owns the branch", () => {
  // The branch, not the selection. Every other safe-send surface composes for
  // whatever session is selected, because it is looking at that session's own
  // working tree. This one is looking at a branch, and the session that wrote it
  // may be in another worktree with no tab open.
  const session = (id: string, branch: string, over: Record<string, unknown> = {}) => ({
    id,
    path: `${ROOT}/.sessions/${id}.jsonl`,
    cwd: ROOT,
    branch,
    title: `title of ${id}`,
    last_active: 1,
    created_at: 1,
    name: null,
    agent: "claude",
    ...over,
  });

  const unit = (branch: string | null) => ({
    folderPath: ROOT,
    projectPath: ROOT,
    branch,
    kind: "plain",
    isCurrent: branch === "main",
    attention: false,
  });

  /** Stand in for Terminal.tsx, the sole consumer of SEND_TO_SESSION. Records
   *  what it was asked to write and answers with `result`. */
  function fakeTerminal(result: "sent" | "blocked" | "timeout") {
    const seen: Record<string, unknown>[] = [];
    const off = onWith<{ requestId: string }>(SEND_TO_SESSION, (req) => {
      seen.push(req as unknown as Record<string, unknown>);
      emitWith(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result });
    });
    return { seen, off };
  }

  const openWithThread = async () => {
    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(document.querySelector("[data-file-status]")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-file-status]")!);
    await waitFor(() => expect(document.querySelector("[data-thread-id]")).toBeTruthy());
  };

  const sendButton = () =>
    screen.getAllByText("Send to agent").find((n) => n.closest("button"))!.closest("button")!;

  beforeEach(async () => {
    resetForgeStatusForTests();
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.fail = null;
    bridge.viewer = null;
    bridge.running = [];
    bridge.files = [file({ path: "src/edit.ts", patch: TWO_HUNKS })];
    bridge.threads = [
      {
        id: "PRRT_1",
        path: "src/edit.ts",
        line: 2,
        startLine: null,
        diffHunk: "@@ -1,3 +1,3 @@\n one\n-two\n+two edited",
        isResolved: false,
        isOutdated: false,
        comments: [
          { id: "C1", author: "reviewer", body: "this drops the error", createdAt: "2026-08-03T09:00:00Z" },
        ],
      },
    ];
    bridge.threadsFail = null;
    localStorage.clear();
  });

  it("sends to the session on the pull request's branch, not the one in front of you", async () => {
    // A plain project: both units share one folder and are told apart only by
    // the branch each session recorded, which is the exact case a second
    // attribution rule gets wrong. `belongsToUnit` is the one Phase 7 uses.
    bridge.sessions = [session("on-main", "main"), session("on-wave", "wave-3")];
    await trackFolders([ROOT]);
    noteForgeUnits([unit("main"), unit("wave-3")]);

    const term = fakeTerminal("sent");
    await openWithThread();
    fireEvent.click(sendButton());
    await waitFor(() => expect(term.seen).toHaveLength(1));
    term.off();

    expect(term.seen[0].sessionId).toBe("on-wave");
    // The whole remark, in one line, with the anchor the agent can open.
    expect(term.seen[0].text).toBe(
      'Review comment on @src/edit.ts line 2 (PR #42). reviewer wrote: "this drops the error". ' +
        "Make the change here; the reply on GitHub is sent from Sway.",
    );
    const note = document.querySelector("[data-send-note]")!;
    expect(note.textContent).toBe("Sent to title of on-wave.");
    // Marked as news that went well. One colour for both outcomes is how "it
    // did not go" ends up reading as "it went".
    expect(note.getAttribute("data-send-note")).toBe("ok");
  });

  it("confirms the session that received it, not whoever owns the branch by then", async () => {
    // The owner can move while a message is in flight: a newer session appears,
    // or the branch does. A confirmation resolved after the send would name a
    // session that received nothing.
    bridge.sessions = [session("on-wave", "wave-3")];
    await trackFolders([ROOT]);
    noteForgeUnits([unit("wave-3")]);
    await openWithThread();

    const off = onWith<{ requestId: string }>(SEND_TO_SESSION, (req) => {
      noteForgeUnits([]); // the branch loses its unit mid-flight
      emitWith(SEND_TO_SESSION_RESULT, { requestId: req.requestId, result: "sent" });
    });
    fireEvent.click(sendButton());
    await waitFor(() => expect(document.querySelector("[data-send-note]")).toBeTruthy());
    off();

    expect(document.querySelector("[data-send-note]")!.textContent).toBe(
      "Sent to title of on-wave.",
    );
  });

  it("shows the whole span a multi-line thread covers, not just its last line", async () => {
    // The card and the message must agree. A comment Sway wrote through Phase 11
    // can span lines, so a header naming only `line` describes a narrower remark
    // than the one being sent.
    (bridge.threads[0] as { startLine: number | null }).startLine = 1;
    bridge.sessions = [];
    await trackFolders([ROOT]);
    noteForgeUnits([]);
    await openWithThread();
    expect(document.querySelector('[data-thread-id="PRRT_1"]')!.textContent).toContain(
      "src/edit.ts:1-2",
    );
  });

  it("names the session and how it is doing before anything is sent", async () => {
    bridge.sessions = [session("on-wave", "wave-3")];
    bridge.running = ["on-wave"];
    await trackFolders([ROOT]);
    await probeBatch([{ id: "on-wave", agent: "claude" }]);
    noteForgeUnits([unit("wave-3")]);

    await openWithThread();
    // A session with no tab caps at "running", which is what a detached agent
    // looks like: real, resumable, and not idle.
    expect(document.querySelector("[data-send-to]")!.getAttribute("data-send-to")).toBe(
      "title of on-wave · Running",
    );
    expect(sendButton().disabled).toBe(false);
  });

  it("refuses, with a reason, when nothing has ever run on the branch", async () => {
    bridge.sessions = [session("on-main", "main")];
    await trackFolders([ROOT]);
    noteForgeUnits([unit("main")]);

    const term = fakeTerminal("sent");
    await openWithThread();
    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector("[data-send-to]")!.getAttribute("data-send-to")).toBe(
      "Nothing has run on wave-3 in this project.",
    );

    fireEvent.click(sendButton());
    await Promise.resolve();
    term.off();
    expect(term.seen).toHaveLength(0);
  });

  it("says on the thread itself when a send is refused or never lands", async () => {
    // On the card, not in a toast. A reader who sent three threads needs to know
    // which one did not go, and a toast that has scrolled them out of view
    // cannot say. The thread is left exactly as it was either way.
    bridge.sessions = [session("on-wave", "wave-3")];
    await trackFolders([ROOT]);
    noteForgeUnits([unit("wave-3")]);
    await openWithThread();

    for (const [result, expected] of [
      ["blocked", "Session is waiting for permission, answer it first."],
      ["timeout", "Couldn't reach the session, try again."],
    ] as const) {
      const term = fakeTerminal(result);
      fireEvent.click(sendButton());
      await waitFor(() =>
        expect(document.querySelector("[data-send-note]")!.textContent).toBe(expected),
      );
      expect(document.querySelector("[data-send-note]")!.getAttribute("data-send-note")).toBe(
        "error",
      );
      term.off();
      // Unsent: nothing was added to the conversation, and the button is live
      // again for a retry.
      expect(document.querySelectorAll('[data-thread-id="PRRT_1"] [data-pending]')).toHaveLength(1);
      expect(sendButton().disabled).toBe(false);
    }
  });
});

describe("landing a pull request", () => {
  // Every control here is gated on the server's `mergeable_state`, never on a
  // reading of the checks or the review verdict taken here: branch protection,
  // required reviewers and required checks are invisible from this side, so a
  // local verdict renders an enabled button the server then refuses.
  const open = async (p = pr()) => {
    render(() => <PrDetail root={ROOT} pr={p} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(document.querySelector("[data-merge-state]")).toBeTruthy());
  };

  const button = (label: string) =>
    screen.getAllByText(label).find((n) => n.closest("button"))!.closest("button")! as HTMLButtonElement;
  const summary = () => document.querySelector("[data-merge-summary]")!.textContent;
  const state = () => document.querySelector("[data-merge-state]")!.getAttribute("data-merge-state");

  beforeEach(() => {
    resetForgeStatusForTests();
    resetSessionActivityForTests();
    resetSessionStoreForTests();
    bridge.calls.length = 0;
    bridge.fail = null;
    bridge.viewer = null;
    bridge.threads = [];
    bridge.threadsFail = null;
    bridge.files = [file({ path: "src/edit.ts" })];
    bridge.mergeable = "clean";
    bridge.mergeableFails = null;
    bridge.mergeFails = null;
    bridge.updateFails = null;
    bridge.sessions = [];
    localStorage.clear();
  });

  it("merges a clean pull request nobody has approved", async () => {
    // The case the whole gate is shaped around. On a single-owner repo the
    // author cannot approve their own pull request, so a review-derived gate
    // would block every merge Sway will ever offer, and the server would have
    // taken all of them.
    await signInAs("skarif2");
    await open(pr({ author: "skarif2" }));
    await waitFor(() => expect(state()).toBe("clean"));
    expect(button("Merge").disabled).toBe(false);

    fireEvent.click(button("Merge"));
    await waitFor(() => expect(cmds("github_merge")).toHaveLength(1));
    // The picker's own value, not a method chosen here: a repo can forbid any of
    // the three and that setting is not readable from this side.
    expect(cmds("github_merge")[0].args).toMatchObject({ number: 42, method: "squash" });
  });

  it("shuts the method picker while the merge is in flight", async () => {
    // The picker is disabled on the same `busy` flag as the buttons beside it:
    // a method changed mid-merge would name one thing while the command already
    // in flight carries another. Asserted before the await, which is the whole
    // window the flag is up for.
    await signInAs("skarif2");
    await open(pr({ author: "skarif2" }));
    await waitFor(() => expect(state()).toBe("clean"));

    const picker = () => screen.getByLabelText("How to merge") as HTMLButtonElement;
    expect(picker().disabled).toBe(false);

    fireEvent.click(button("Merge"));
    expect(picker().disabled).toBe(true);

    await waitFor(() => expect(cmds("github_merge")).toHaveLength(1));
  });

  it("merges by whichever method the picker names", async () => {
    // The picker is a listbox behind a button since #106, so a choice is two
    // presses and the rows exist only while it is open. What this pins is the
    // round trip: the row pressed is the method the command carries.
    await signInAs("skarif2");
    await open(pr({ author: "skarif2" }));
    await waitFor(() => expect(state()).toBe("clean"));

    pointerClick(screen.getByLabelText("How to merge"));
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "Merge commit" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.click(button("Merge"));
    await waitFor(() => expect(cmds("github_merge")).toHaveLength(1));
    expect(cmds("github_merge")[0].args).toMatchObject({ number: 42, method: "merge" });
  });

  it("holds the button shut on the server's verdict, and says which one", async () => {
    bridge.mergeable = "blocked";
    await open();
    await waitFor(() => expect(state()).toBe("blocked"));
    expect(button("Merge").disabled).toBe(true);
    expect(summary()).toContain("rule on the base branch");
    // Never a guess at *which* rule. That lives in a branch-protection setting
    // this app cannot read, and inventing "needs one approval" would be Sway
    // putting words in the server's mouth.
    expect(summary()).not.toMatch(/approv|review/i);
  });

  it("shows the server's own sentence when it refuses the merge", async () => {
    // The 405 that carries the only actionable thing in the exchange. A generic
    // "could not merge" would throw it away.
    bridge.mergeFails = {
      kind: "notMergeable",
      message: "At least 1 approving review is required by reviewers with write access.",
    };
    await open();
    await waitFor(() => expect(state()).toBe("clean"));
    fireEvent.click(button("Merge"));

    await waitFor(() => expect(document.querySelector("[data-merge-error]")).toBeTruthy());
    expect(document.querySelector("[data-merge-error]")!.textContent).toBe(
      "At least 1 approving review is required by reviewers with write access.",
    );
    // Refused, so nothing claims it landed.
    expect(summary()).not.toBe("Merged.");
  });

  it("offers an update only to a branch that is merely behind", async () => {
    // A conflicted branch is the sharp one: update-branch is itself a merge, so
    // offering it there is offering a button that cannot work.
    bridge.mergeable = "dirty";
    await open();
    await waitFor(() => expect(state()).toBe("dirty"));
    expect(screen.queryByText("Update branch")).toBeNull();
    expect(button("Merge").disabled).toBe(true);
  });

  it("updates a behind branch and re-reads the verdict rather than assuming it", async () => {
    // The update is queued on the server (202), so `behind` may still be the
    // current answer for a moment. Assuming `clean` would offer a merge the
    // server refuses.
    bridge.mergeable = "behind";
    await open();
    await waitFor(() => expect(state()).toBe("behind"));
    expect(button("Merge").disabled).toBe(true);

    bridge.mergeable = "clean";
    fireEvent.click(button("Update branch"));
    await waitFor(() => expect(cmds("github_update_branch")).toHaveLength(1));
    await waitFor(() => expect(state()).toBe("clean"));
    expect(cmds("github_mergeability").length).toBeGreaterThan(1);
  });

  it("keeps the button inert while nobody has asked, which is not a verdict", async () => {
    // A read that failed leaves the state unread. Rendering that as a verdict
    // would put a live Merge button on a pull request nothing is known about.
    bridge.mergeableFails = { kind: "transport", message: "offline" };
    await open();
    expect(state()).toBe("unread");
    expect(button("Merge").disabled).toBe(true);
    // And the diff is still worth reading: an unread verdict is not an error
    // over the whole pull request.
    await waitFor(() => expect(document.querySelector("[data-file-status]")).toBeTruthy());
  });

  it("hands the branch deletion to the sidebar, with its guards", async () => {
    // Never deleted from here. The sidebar's dialogs already guard a dirty
    // worktree, unpushed commits and agents still running in the folder, and a
    // second delete path in this panel is a second place to forget all three.
    noteForgeUnits([
      {
        folderPath: `${ROOT}/.worktrees/wave-3`,
        projectPath: ROOT,
        branch: "wave-3",
        kind: "worktree",
        isCurrent: false,
        attention: false,
      },
    ]);
    const asked: RemoveBranchUnit[] = [];
    const off = onWith<RemoveBranchUnit>(REMOVE_BRANCH_UNIT, (d) => asked.push(d));

    await open();
    await waitFor(() => expect(state()).toBe("clean"));
    fireEvent.click(button("Merge"));
    await waitFor(() => expect(summary()).toBe("Merged."));

    fireEvent.click(button("Delete branch…"));
    off();
    expect(asked).toEqual([{ projectPath: ROOT, branch: "wave-3" }]);
    // And no delete of its own.
    expect(cmds("remove_worktree_and_branch")).toHaveLength(0);
    expect(cmds("delete_remote_branch")).toHaveLength(0);
  });

  it("does not offer to delete a branch this machine never checked out", async () => {
    // Nothing local to remove, so the button would open a dialog about a branch
    // the sidebar does not list: a dead end dressed as an action.
    noteForgeUnits([]);
    await open();
    await waitFor(() => expect(state()).toBe("clean"));
    fireEvent.click(button("Merge"));
    await waitFor(() => expect(summary()).toBe("Merged."));
    expect(screen.queryByText("Delete branch…")).toBeNull();
  });
});

describe("the pull request detail, to axe", () => {
  it("has no accessibility violations", async () => {
    render(() => <PrDetail root={ROOT} pr={pr()} onBack={() => {}} onLanded={() => {}} />);
    await waitFor(() => expect(screen.getByText("Review")).toBeTruthy());

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });
});
