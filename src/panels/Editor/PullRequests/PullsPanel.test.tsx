import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../../test/axe";
import { pointerClick } from "../../../test/menus";
import type { AuthState, PullRequest } from "../../../utils/forgeTypes";
import type { BranchSync } from "../../../utils/gitActions";
import type { Selection } from "../../LeftSidebar/LeftSidebar";

// The Pull requests panel, scoped to the branch this pane has checked out.
//
// Two things it has to get right that a working-looking panel would not show:
//
//   1. **Every control is gated on the server's verdict.** `mergeableState`
//      accounts for branch protection Tori cannot read, so a button enabled on
//      a local reading is one the server refuses after the click.
//   2. **A blank is never a verdict.** No summary yet, a host that does not
//      describe a pull request, and a branch no poll tick covered all render
//      nothing where a count would go, and none of them mean "nobody approved"
//      or "no checks".

const ROOT = "/root/work/gh";
const BRANCH = "wave-3";

/// jsdom implements no ResizeObserver, and components the panel mounts ask for
/// one. Nothing here reads a width, so it never reports.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// Two digits, not the design's `#412`: `check-tokens.mjs` reads `#[0-9a-f]{3,8}`
// as a hex colour, so a three-digit number in a test fails the token guard.
// `PrDiffView.test.tsx` does the same.
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
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
  headSha: "abc123",
  headRepoIsOrigin: true,
  url: "https://github.com/skarif2/tori/pull/42",
  mergeableState: "clean",
  ...over,
});

const SYNC: BranchSync = {
  detached: false,
  dirty: false,
  head_committed_at: 0,
  upstream: { ahead: 0, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false },
  base: { name: "main", ahead: 12, behind: 0, conflicts: [] },
};

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  branch: "wave-3" as string | null,
  sync: null as unknown,
  origin: "git@github.com:skarif2/tori.git" as string | null,
  base: "main" as string | null,
  directPr: null as unknown,
  statuses: [] as unknown[],
  files: [] as unknown[],
  filesTruncated: false,
  filesFail: null as { kind: string; message: string } | null,
  threads: [] as unknown[],
  summary: null as unknown,
  summaryFails: null as { kind: string; message: string } | null,
  mergeFails: null as { kind: string; message: string } | null,
  updateFails: null as { kind: string; message: string } | null,
  aheadBehind: { ahead: 0, behind: 0, has_upstream: true } as unknown,
  createdPr: null as unknown,
  createFails: null as { kind: string; message: string } | null,
  accountPending: false,
  branchPaths: [] as string[],
  directPrFails: null as { kind: string; message: string } | null,
  directPrPending: false,
  /** What `forge_repo_account` answers. `pick` is the one pause reason that is
   *  about the repo rather than about the account. */
  repoAccount: null as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    if (cmd === "list_branches") return Promise.resolve(bridge.branch ? [{ name: bridge.branch, current: true }] : []);
    if (cmd === "git_branch_sync") return Promise.resolve(bridge.sync);
    if (cmd === "git_origin") return Promise.resolve(bridge.origin);
    if (cmd === "git_default_base_branch") return Promise.resolve(bridge.base);
    if (cmd === "git_ahead_behind") return Promise.resolve(bridge.aheadBehind);
    if (cmd === "git_branch_paths") return Promise.resolve(bridge.branchPaths);
    if (cmd === "forge_push_and_create_pr")
      return bridge.createFails ? Promise.reject(bridge.createFails) : Promise.resolve(bridge.createdPr);
    if (cmd === "forge_pr_for_branch") {
      if (bridge.directPrPending) return new Promise(() => {});
      return bridge.directPrFails ? Promise.reject(bridge.directPrFails) : Promise.resolve(bridge.directPr);
    }
    if (cmd === "forge_unit_statuses")
      return Promise.resolve({
        statuses: bridge.statuses,
        uncovered: 0,
        rate: { remaining: 4800, limit: 5000, resetAt: null },
      });
    if (cmd === "forge_pr_summary")
      return bridge.summaryFails ? Promise.reject(bridge.summaryFails) : Promise.resolve(bridge.summary);
    if (cmd === "forge_merge") return bridge.mergeFails ? Promise.reject(bridge.mergeFails) : Promise.resolve(null);
    if (cmd === "forge_update_branch")
      return bridge.updateFails ? Promise.reject(bridge.updateFails) : Promise.resolve(null);
    if (cmd === "forge_pr_files")
      return bridge.filesFail
        ? Promise.reject(bridge.filesFail)
        : Promise.resolve({ items: bridge.files, truncated: bridge.filesTruncated });
    if (cmd === "forge_review_threads") return Promise.resolve({ items: bridge.threads, truncated: false });
    if (cmd === "forge_list_prs") return Promise.resolve({ items: [], truncated: false });
    if (cmd === "forge_repo_account")
      return bridge.accountPending
        ? new Promise(() => {})
        : Promise.resolve(
            bridge.repoAccount ?? {
              kind: "account",
              accountId: "personal",
              host: "github.com",
              auth: { kind: "signedIn", login: "skarif2" },
              capabilities: {},
            },
          );
    return Promise.resolve(null);
  },
}));

// `push()` in `gitActions` resolves on a Tauri event rather than on its own
// command, so a push in a test that never fires one hangs. Real `listen` would
// reach for an IPC bridge that is not here at all.
const handlers: Record<string, ((e: { payload: unknown }) => void)[]> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (handlers[name] ??= []).push(fn);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
  onAction: () => Promise.resolve(() => {}),
}));

const { default: PullsPanel } = await import("./PullsPanel");
const {
  noteForgeAccounts,
  noteForgeEnabled,
  noteWatchedProjects,
  pollNow,
  resetForgeStatusForTests,
  resolveForgeRepo,
} = await import("../../../utils/forgeStatus");
const { addPending, notePr, prEntry, resetPrReviewStoreForTests, setViewingPr, viewingPr } =
  await import("../../../utils/prReviewStore");
const { prDiffTabId, prTabId } = await import("../../../utils/syntheticTabs");
const { onWith, ADD_BRANCH_UNIT, OPEN_IN_EDITOR, SEND_TO_SESSION, SEND_TO_SESSION_RESULT } =
  await import("../../../utils/events");
const { resetPrListStoreForTests } = await import("../../../utils/prListStore");
const { enterRoots, refreshMeta } = await import("../../../utils/gitActions");
const { noteForgeUnits, resetSessionActivityForTests } = await import("../../../utils/sessionActivity");
const { REMOVE_BRANCH_UNIT } = await import("../../../utils/events");

const cmds = (name: string) => bridge.calls.filter((c) => c.cmd === name);

/** The detail read, around the fields a test cares about. */
const summaryOf = (mergeableState: string, counts: unknown = undefined) => ({
  mergeableState,
  updatedAt: "2026-09-18T11:02:00Z",
  counts:
    counts === undefined
      ? {
          commits: 2,
          changedFiles: 1,
          additions: 1,
          deletions: 1,
          reviews: { approved: 1, changesRequested: 0 },
        }
      : counts,
});

const noteAuth = (auth: AuthState) =>
  noteForgeAccounts(
    auth.kind === "signedOut"
      ? []
      : [
          {
            id: "personal",
            provider: "github",
            baseUrl: "https://github.com",
            login: "skarif2",
            label: "skarif2",
            expiresAt: null,
            rejectedAt: null,
            scopes: null,
            source: "token",
            orgAccess: [],
            auth,
          },
        ],
  );

/// What the create form's draft button writes to. Null in every test but the
/// one about that button: the panel is mounted beside a session picker it does
/// not own, and "nobody is picked" is the resting state.
let selection: Selection | null = null;

const signIn = () => {
  noteAuth({ kind: "signedIn", login: "skarif2" });
  noteForgeEnabled(true);
};

/// Every answer the bridge gives back to its resting shape. Applied per `open`
/// as well as per test, because several tests open the panel more than once and
/// an override left behind from the last one is a state nobody asked for.
function restBridge() {
  bridge.branch = BRANCH;
  bridge.sync = SYNC;
  bridge.origin = "git@github.com:skarif2/tori.git";
  bridge.base = "main";
  bridge.directPr = null;
  bridge.statuses = [];
  bridge.files = [];
  bridge.filesTruncated = false;
  bridge.filesFail = null;
  bridge.threads = [];
  bridge.summary = summaryOf("clean");
  bridge.summaryFails = null;
  bridge.mergeFails = null;
  bridge.updateFails = null;
  bridge.aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
  bridge.createdPr = null;
  bridge.createFails = null;
  bridge.accountPending = false;
  bridge.branchPaths = [];
  bridge.directPrFails = null;
  bridge.directPrPending = false;
  bridge.repoAccount = null;
}

/// Put the branch in the git store, render, and let every read settle. The
/// account state is the caller's, since half these tests are about not having
/// one.
async function open(over: Partial<typeof bridge> = {}) {
  restBridge();
  Object.assign(bridge, over);
  noteWatchedProjects([{ path: ROOT, units: [{ branch: BRANCH, visible: true }] }]);
  enterRoots([ROOT]);
  await refreshMeta(ROOT);
  // Not awaited where the account read is deliberately left hanging: that is
  // the window this panel can be in before anything knows which account serves
  // the repo, and awaiting it would never return.
  if (bridge.accountPending) void resolveForgeRepo(ROOT);
  else await resolveForgeRepo(ROOT);
  const view = render(() => <PullsPanel root={ROOT} selected={selection} />);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return view;
}

/// The poll's record for this branch, which is where the checks and the review
/// verdict come from. Never fetched by the panel.
const unit = (over: Record<string, unknown> = {}) => ({
  headRef: BRANCH,
  pullRequest: pr(),
  checks: { state: "none", total: 0, failing: 0, contexts: [] },
  reviewDecision: "none",
  ...over,
});

/** The merge control and the checks list are tabs of the panel's detail
 *  section now, so a test about either picks its tab before it looks. */
const showTab = async (name: string) => fireEvent.click(await screen.findByRole("tab", { name }));

const mergeButton = () =>
  screen
    .getAllByRole("button")
    .find((b) => /^(Merge|Squash and merge|Rebase and merge|Merge commit)$/.test(b.textContent ?? ""))!;

beforeEach(() => {
  bridge.calls.length = 0;
  selection = null;
  for (const key of Object.keys(handlers)) delete handlers[key];
  restBridge();
  localStorage.clear();
  resetPrReviewStoreForTests();
  resetPrListStoreForTests();
  resetForgeStatusForTests();
  resetSessionActivityForTests();
});

describe("the branch's pull request", () => {
  it("shows the one for the branch in front of you, from the poll", async () => {
    signIn();
    await open({ statuses: [unit()] });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());
    expect(screen.getByText("Let a pull request be read in place")).toBeTruthy();
    expect(screen.getByText(BRANCH)).toBeTruthy();
  });

  it("resolves a branch the poll never covered through its own read", async () => {
    // Nothing in `statuses`, so the poll has no record of this unit. Without
    // the direct read the panel would say "checking" for as long as the pane
    // stayed open.
    signIn();
    await open({ directPr: pr({ number: 77 }) });

    await waitFor(() => expect(screen.getByText("#77")).toBeTruthy());
    expect(cmds("forge_pr_for_branch")[0].args).toMatchObject({
      projectPath: ROOT,
      branch: BRANCH,
      refresh: false,
    });
  });

  it("says which kind of nothing it has, not just that it has nothing", async () => {
    // Four surfaces that all render no pull request. The sentences are pinned
    // in `pullsPanelState.test.ts`; what this holds is that the panel draws the
    // one belonging to the state it is in.
    signIn();
    const onBase = await open({ branch: "main", sync: { ...SYNC, base: null } });
    await waitFor(() => expect(document.querySelector('[data-panel-state="onBase"]')).toBeTruthy());
    onBase.unmount();

    resetForgeStatusForTests();
    signIn();
    const inert = await open({ origin: "git@bitbucket.org:skarif2/tori.git" });
    await waitFor(() => expect(document.querySelector('[data-panel-state="inert"]')).toBeTruthy());
    // The remote itself, because which one it is is the whole point.
    expect(screen.getByText("git@bitbucket.org:skarif2/tori.git")).toBeTruthy();
    inert.unmount();

    resetForgeStatusForTests();
    noteAuth({ kind: "signedOut" });
    const out = await open();
    await waitFor(() => expect(document.querySelector('[data-panel-state="paused"]')).toBeTruthy());
    out.unmount();

    resetForgeStatusForTests();
    signIn();
    const noPr = await open({ directPr: null });
    await waitFor(() => expect(document.querySelector('[data-panel-state="noPrPushed"]')).toBeTruthy());
    noPr.unmount();
  });

  it("asks nothing of the forge while the integration is paused", async () => {
    // Rust refuses too, but a request the frontend never makes is the half that
    // costs nothing, and the pause is exactly where the answer could not be
    // shown even if it arrived.
    noteAuth({ kind: "signedOut" });
    await open();
    expect(cmds("forge_pr_for_branch")).toHaveLength(0);
  });
});

describe("the three verdict rows", () => {
  it("expands the checks row into the checks behind it", async () => {
    signIn();
    await open({
      statuses: [
        unit({
          checks: {
            state: "failure",
            total: 3,
            failing: 1,
            contexts: [
              { name: "build", state: "failure", url: "https://ci.test/1" },
              { name: "lint", state: "success", url: null },
              { name: "coverage", state: "success", url: "https://ci.test/3" },
            ],
          },
        }),
      ],
    });
    await pollNow("manual");

    const row = await screen.findByText("1 of 3 checks failing");
    // Collapsed by default: three rows of green on every healthy pull request
    // is the column saying what the line above it already said.
    expect(screen.queryByText("build")).toBeNull();

    fireEvent.click(row.closest("button")!);

    await waitFor(() => expect(screen.getByText("build")).toBeTruthy());
    expect(screen.getByText("lint")).toBeTruthy();
    expect(screen.getByText("coverage")).toBeTruthy();
  });

  it("leaves the counts blank rather than zero when nothing has counted them", async () => {
    // `counts: null` is a host that does not describe a pull request in one
    // read. "No reviews yet" there would be a verdict nobody reached.
    signIn();
    await open({ statuses: [unit()], summary: summaryOf("clean", null) });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("Reviews not counted yet.")).toBeTruthy());
    // And the merge row still works off the same summary: the verdict is the
    // part every provider answers, so it is not behind the option.
    expect(screen.getByText("Ready to merge.")).toBeTruthy();
    await showTab("Merge");
    expect(mergeButton().hasAttribute("disabled")).toBe(false);
  });

  it("takes the counts from the summary and the colour from the poll", async () => {
    signIn();
    await open({
      statuses: [unit({ reviewDecision: "changesRequested" })],
      summary: summaryOf("blocked", {
        commits: 2,
        changedFiles: 1,
        additions: 1,
        deletions: 1,
        reviews: { approved: 1, changesRequested: 2 },
      }),
    });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("1 approval, 2 change requests")).toBeTruthy());
    expect(document.querySelector('[data-verdict="reviews"]')!.getAttribute("data-decision")).toBe("changesRequested");
  });

  it("shows the honest blank for a pull request no poll tick covered", async () => {
    // Picked in the list tab, on somebody else's branch. The poll only covers
    // branches this machine has units for, so its checks are unknown, and that
    // is exactly what the list rows show today.
    const elsewhere = pr({ number: 77, headRef: "not-here" });
    notePr(ROOT, 77, elsewhere);
    setViewingPr(ROOT, 77);
    signIn();
    await open({ statuses: [unit()] });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("#77")).toBeTruthy());
    expect(screen.getByText("No checks read for this branch.")).toBeTruthy();
  });
});

describe("landing it", () => {
  it("names the method it will use when the server says it can merge", async () => {
    signIn();
    await open({ statuses: [unit()], summary: summaryOf("clean") });
    await pollNow("manual");

    await showTab("Merge");
    await waitFor(() => expect(mergeButton().textContent).toBe("Squash and merge"));
    expect(mergeButton().hasAttribute("disabled")).toBe(false);
  });

  it("holds the button shut on a blocked verdict, and says so without guessing", async () => {
    // The specifics live in a branch-protection rule Tori cannot read. This is
    // the one condition where merging is genuinely impossible from here, and
    // the only one that greys the button out.
    signIn();
    await open({ statuses: [unit()], summary: summaryOf("blocked") });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("A rule on the base branch is holding this merge.")).toBeTruthy());
    await showTab("Merge");
    expect(mergeButton().textContent).toBe("Merge");
    expect(mergeButton().hasAttribute("disabled")).toBe(true);
  });

  it("offers a conflicted branch an update and re-reads the verdict it changed", async () => {
    // The update is queued on the server (202), so `dirty` may still be the
    // current answer for a moment. Guessing `clean` here would offer a merge
    // the server refuses.
    signIn();
    await open({ statuses: [unit()], summary: summaryOf("dirty") });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("Update branch")).toBeTruthy());
    const read = cmds("forge_pr_summary").length;
    fireEvent.click(screen.getByText("Update branch"));

    await waitFor(() => expect(cmds("forge_update_branch")).toHaveLength(1));
    await waitFor(() => expect(cmds("forge_pr_summary").length).toBe(read + 1));
  });

  it("shows the server's own sentence when it refuses the merge", async () => {
    // `String(e)` on a rejected forge command renders "[object Object]", and
    // GitHub's wording is the only thing that can name the rule that refused.
    signIn();
    await open({
      statuses: [unit()],
      summary: summaryOf("clean"),
      mergeFails: { kind: "forbidden", message: "At least 1 approving review is required" },
    });
    await pollNow("manual");
    await showTab("Merge");
    await waitFor(() => expect(mergeButton().textContent).toBe("Squash and merge"));

    fireEvent.click(mergeButton());

    await waitFor(() => expect(screen.getByText("At least 1 approving review is required")).toBeTruthy());
  });

  it("tells the listing when one has been landed", async () => {
    // Merging makes every listing of this project wrong, and a listing is where
    // the user goes to check it worked. The list lives in its own tab now, so
    // the store is what gets told.
    signIn();
    await open({ statuses: [unit()], summary: summaryOf("clean") });
    await pollNow("manual");
    await showTab("Merge");
    await waitFor(() => expect(mergeButton().textContent).toBe("Squash and merge"));

    const listed = cmds("forge_list_prs").length;
    fireEvent.click(mergeButton());

    await waitFor(() => expect(cmds("forge_list_prs").length).toBe(listed + 1));
    expect(screen.getByText("Merged.")).toBeTruthy();
  });
});

const file = (over: Record<string, unknown> = {}) => ({
  path: "src/utils/forgeChip.ts",
  previousPath: null,
  status: "modified",
  additions: 84,
  deletions: 12,
  patch: "@@ -1,1 +1,1 @@\n-a\n+b",
  ...over,
});

describe("the file rows", () => {
  it("spells out everything it says in colour", async () => {
    // The status letter, the two counts and the unresolved mark are a letter,
    // two numbers and a glyph on screen. The accessible name is where they are
    // words.
    signIn();
    await open({
      statuses: [unit()],
      files: [file()],
      threads: [
        {
          id: "t1",
          path: "src/utils/forgeChip.ts",
          line: 4,
          startLine: null,
          diffHunk: "",
          isResolved: false,
          isOutdated: false,
          comments: [],
        },
        {
          id: "t2",
          path: "src/utils/forgeChip.ts",
          line: 6,
          startLine: null,
          diffHunk: "",
          isResolved: true,
          isOutdated: false,
          comments: [],
        },
      ],
    });
    await pollNow("manual");

    // The resolved one is not counted: it is still reachable in the diff, and
    // counting it marks a file as needing attention it does not.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Modified, src/utils/forgeChip.ts, 84 added, 12 removed, 1 unresolved comment",
        }),
      ).toBeTruthy(),
    );
  });

  it("keeps a row to its folder, its name, its letter and its box", async () => {
    // The line counts came off the rows: the pane resizes down to 160px, and a
    // row carrying a name, a status and two numbers carries none of them.
    signIn();
    await open({ statuses: [unit()], files: [file()] });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("forgeChip.ts")).toBeTruthy());
    expect(screen.getByText("src/utils")).toBeTruthy();
    expect(screen.getByText("M")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Viewed, src/utils/forgeChip.ts" })).toBeTruthy();
    expect(screen.queryByText("+84")).toBeNull();
  });

  it("hands the store the pull request before opening the file's tab", async () => {
    // The order is the point. The tab reads the store on mount and there is no
    // read by number, so a row that opened first and told second would render
    // "no pull request here carries that number" over a diff it was holding.
    signIn();
    await open({ directPr: pr({ number: 77 }), files: [file()] });
    await waitFor(() => expect(screen.getByText("forgeChip.ts")).toBeTruthy());

    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, (e) => opened.push(e.path));
    fireEvent.click(screen.getByText("forgeChip.ts"));
    off();

    // The direct read found it, not the poll: `notePr` is the only thing that
    // makes the tab work for a branch no tick has covered.
    expect(prEntry(ROOT, 77).pr).toMatchObject({ number: 77 });
    expect(opened).toEqual([prDiffTabId(ROOT, 77, "src/utils/forgeChip.ts")]);
  });

  it("says so when the API stopped describing the diff", async () => {
    // GitHub's own ceiling. A short list that looks whole is the failure
    // nobody reports, so the count says both numbers before any scrolling.
    signIn();
    await open({
      statuses: [unit()],
      files: [file()],
      filesTruncated: true,
      summary: summaryOf("clean", {
        commits: 2,
        changedFiles: 42,
        additions: 359,
        deletions: 148,
        reviews: { approved: 0, changesRequested: 0 },
      }),
    });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("1 of 42")).toBeTruthy());
    expect(screen.getByText(/more files than the API will describe/)).toBeTruthy();
  });
  it("gives every kind of change the API reports its own row", async () => {
    // Four statuses, four letters. The rename is the one that cannot be
    // inferred: without `previousPath` it reads as a new file beside a deleted
    // one, which is two changes where there was one.
    signIn();
    await open({
      statuses: [unit()],
      files: [
        file({ path: "src/new.ts", status: "added", additions: 9, deletions: 0 }),
        file({ path: "src/gone.ts", status: "removed", additions: 0, deletions: 4 }),
        file({ path: "src/edit.ts", status: "modified" }),
        file({
          path: "src/to.ts",
          previousPath: "src/from.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
        }),
      ],
    });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("new.ts")).toBeTruthy());
    const statuses = Array.from(document.querySelectorAll("[data-file-status]")).map((n) =>
      n.getAttribute("data-file-status"),
    );
    // By name inside the directory, not in the order the API sent them: the
    // rows are a tree now, and a tree that kept the server's order would put
    // the same four files somewhere else on the next read.
    expect(statuses).toEqual(["modified", "removed", "added", "renamed"]);
    // The row shows the new path; both halves are in the name it says out loud.
    expect(
      screen.getByRole("button", {
        name: "Renamed, src/from.ts to src/to.ts, 0 added, 0 removed",
      }),
    ).toBeTruthy();
  });

  it("lists all forty files of a forty-file pull request", async () => {
    // The API pages at 100 and Rust walks to the ceiling; what this pins is
    // that the panel renders what came back rather than slicing it to
    // something that fits in the column.
    signIn();
    await open({
      statuses: [unit()],
      files: Array.from({ length: 40 }, (_, i) => file({ path: `src/f${i}.ts` })),
    });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("f0.ts")).toBeTruthy());
    expect(document.querySelectorAll("[data-file-status]")).toHaveLength(40);
    expect(screen.getByText("f39.ts")).toBeTruthy();
  });
});

describe("landing it, once it has landed", () => {
  it("shuts the method picker while the merge is in flight", async () => {
    // The picker is disabled on the same `busy` flag as the button beside it:
    // a method changed mid-merge would name one thing while the command already
    // in flight carries another. Asserted before the await, which is the whole
    // window the flag is up for.
    signIn();
    await open({ statuses: [unit()], summary: summaryOf("clean") });
    await pollNow("manual");
    await showTab("Merge");
    await waitFor(() => expect(mergeButton().textContent).toBe("Squash and merge"));

    const picker = () => screen.getByLabelText("How to merge") as HTMLButtonElement;
    expect(picker().disabled).toBe(false);

    fireEvent.click(mergeButton());
    expect(picker().disabled).toBe(true);

    await waitFor(() => expect(cmds("forge_merge")).toHaveLength(1));
  });

  it("merges by whichever method the picker names", async () => {
    // The picker is a listbox behind a button, so a choice is two presses and
    // the rows exist only while it is open. What this pins is the round trip:
    // the row pressed is the method the command carries.
    signIn();
    await open({ statuses: [unit()], summary: summaryOf("clean") });
    await pollNow("manual");
    await showTab("Merge");
    await waitFor(() => expect(mergeButton().textContent).toBe("Squash and merge"));

    pointerClick(screen.getByLabelText("How to merge"));
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "Merge commit" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.click(mergeButton());
    await waitFor(() => expect(cmds("forge_merge")).toHaveLength(1));
    expect(cmds("forge_merge")[0].args).toMatchObject({ number: 42, method: "merge" });
  });

  it("hands the branch deletion to the sidebar, with its guards", async () => {
    // Never deleted from here. The sidebar's dialogs already guard a dirty
    // worktree, unpushed commits and agents still running in the folder, and a
    // second delete path in this panel is a second place to forget all three.
    noteForgeUnits([
      {
        folderPath: `${ROOT}/.worktrees/wave-3`,
        projectPath: ROOT,
        branch: BRANCH,
        kind: "worktree",
        isCurrent: false,
        attention: false,
      },
    ]);
    const asked: { projectPath: string; branch: string }[] = [];
    const off = onWith<{ projectPath: string; branch: string }>(REMOVE_BRANCH_UNIT, (d) => asked.push(d));

    signIn();
    await open({ statuses: [unit()], summary: summaryOf("clean") });
    await pollNow("manual");
    await showTab("Merge");
    await waitFor(() => expect(mergeButton().textContent).toBe("Squash and merge"));
    fireEvent.click(mergeButton());
    await waitFor(() => expect(screen.getByText("Merged.")).toBeTruthy());

    fireEvent.click(screen.getByText("Delete branch…"));
    off();
    expect(asked).toEqual([{ projectPath: ROOT, branch: BRANCH }]);
    // And no delete of its own.
    expect(cmds("remove_worktree_and_branch")).toHaveLength(0);
    expect(cmds("delete_remote_branch")).toHaveLength(0);
  });

  it("does not offer to delete a branch this machine never checked out", async () => {
    // Nothing local to remove, so the button would open a dialog about a branch
    // the sidebar does not list: a dead end dressed as an action.
    noteForgeUnits([]);
    signIn();
    await open({ statuses: [unit()], summary: summaryOf("clean") });
    await pollNow("manual");
    await showTab("Merge");
    await waitFor(() => expect(mergeButton().textContent).toBe("Squash and merge"));
    fireEvent.click(mergeButton());

    await waitFor(() => expect(screen.getByText("Merged.")).toBeTruthy());
    expect(screen.queryByText("Delete branch…")).toBeNull();
  });

  it("shows the server's own sentence when the files cannot be read", async () => {
    // A pull request whose patches will not load is still one worth standing
    // in front of: the identity and the verdicts stay, and the failure is a
    // line rather than the whole surface.
    signIn();
    await open({ statuses: [unit()], filesFail: { kind: "rateLimited", message: "the GitHub rate limit is spent" } });
    await pollNow("manual");

    await waitFor(() => expect(screen.getByText("the GitHub rate limit is spent")).toBeTruthy());
    expect(screen.getByText("#42")).toBeTruthy();
  });

  it("has no accessibility violations", async () => {
    signIn();
    await open({
      statuses: [
        unit({
          checks: {
            state: "failure",
            total: 1,
            failing: 1,
            contexts: [{ name: "build", state: "failure", url: "https://ci.test/1" }],
          },
        }),
      ],
      files: [file()],
    });
    await pollNow("manual");
    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });
});

describe("the header and the footer", () => {
  it("re-reads all three parts and the poll behind them", async () => {
    signIn();
    await open({ statuses: [unit()] });
    await pollNow("manual");
    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());

    const before = {
      files: cmds("forge_pr_files").length,
      threads: cmds("forge_review_threads").length,
      summary: cmds("forge_pr_summary").length,
      poll: cmds("forge_unit_statuses").length,
    };
    fireEvent.click(screen.getByRole("button", { name: "Re-read this pull request" }));

    await waitFor(() => expect(cmds("forge_pr_files").length).toBe(before.files + 1));
    expect(cmds("forge_review_threads").length).toBe(before.threads + 1);
    expect(cmds("forge_pr_summary").length).toBe(before.summary + 1);
    await waitFor(() => expect(cmds("forge_unit_statuses").length).toBe(before.poll + 1));
  });

  it("offers the way back to the branch only while showing somebody else's", async () => {
    signIn();
    await open({ statuses: [unit()] });
    await pollNow("manual");
    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());
    expect(screen.queryByText("Back to this branch")).toBeNull();

    notePr(ROOT, 77, pr({ number: 77, headRef: "not-here" }));
    setViewingPr(ROOT, 77);

    await waitFor(() => expect(screen.getByText("#77")).toBeTruthy());
    fireEvent.click(screen.getByText("Back to this branch"));

    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());
    expect(viewingPr(ROOT)).toBeNull();
  });

  it("keeps the footer off the screen until there is a review to finish", async () => {
    // A permanent submit bar over a pull request nobody is reviewing is chrome
    // on every diff in the app.
    signIn();
    await open({ statuses: [unit()] });
    await pollNow("manual");
    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());
    expect(screen.queryByText("Finish review")).toBeNull();

    addPending(ROOT, 42, {
      path: "src/utils/forgeChip.ts",
      line: 4,
      side: "RIGHT",
      startLine: null,
      startSide: null,
      body: "this drops the error",
      rowText: "const a = 1;",
    });

    await waitFor(() => expect(screen.getByText("Finish review")).toBeTruthy());
    // Counted apart, because one unsendable anchor blocks the whole submit and
    // a plain "1 pending" reads as ready when it is not.
    expect(screen.getByText("1 pending, 1 needs a look")).toBeTruthy();

    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, (e) => opened.push(e.path));
    fireEvent.click(screen.getByText("Finish review"));
    off();
    expect(opened).toEqual([prTabId(ROOT, 42)]);
  });
});

describe("starting a pull request from the panel", () => {
  // Every one of these states says there is no pull request. What separates
  // them is what to do about it, and a panel that draws four different
  // sentences over the same absent button has only told you the bad news.
  const UNPUSHED: BranchSync = {
    ...SYNC,
    upstream: { ahead: 3, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false },
  };

  const button = (label: string) =>
    screen
      .getAllByText(label)
      .find((n) => n.closest("button"))!
      .closest("button")!;

  it("hands a new branch to the sidebar rather than cutting one here", async () => {
    // The sidebar owns the branch-unit list and the dialog that adds to it, and
    // the project's kind decides whether that is a worktree or a branch. A
    // second create path here would be a second place to get that wrong.
    signIn();
    await open({ branch: "main", sync: { ...SYNC, base: null } });
    await waitFor(() => expect(document.querySelector('[data-panel-state="onBase"]')).toBeTruthy());

    const asked: unknown[] = [];
    const off = onWith(ADD_BRANCH_UNIT, (d) => asked.push(d));
    fireEvent.click(button("New branch from base"));
    off();

    expect(asked).toEqual([{ projectPath: ROOT, base: "main" }]);
  });

  it("opens the form in place on a host this account can serve", async () => {
    signIn();
    await open({ sync: UNPUSHED });
    await waitFor(() => expect(document.querySelector('[data-panel-state="noPrUnpushed"]')).toBeTruthy());

    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    fireEvent.click(button("Push and open a pull request"));

    await waitFor(() => expect(screen.getByPlaceholderText("What this branch does")).toBeTruthy());
    // Nothing has been pushed and no browser tab was opened: the push is the
    // create command's own first half, and it happens on confirm.
    expect(cmds("git_push")).toHaveLength(0);
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
  });

  it("pushes and stops there when that is all that was asked for", async () => {
    // Its own button, because a branch can be worth having on origin long
    // before it is worth reviewing, and the other button cannot be undone by
    // closing a dialog.
    signIn();
    await open({ sync: UNPUSHED });
    await waitFor(() => expect(document.querySelector('[data-panel-state="noPrUnpushed"]')).toBeTruthy());

    fireEvent.click(button("Push only"));
    await waitFor(() => expect(cmds("git_push")).toHaveLength(1));
    expect(cmds("git_push")[0].args).toMatchObject({ repo: ROOT, remote: "origin", branch: BRANCH });
    expect(screen.queryByPlaceholderText("What this branch does")).toBeNull();
    expect(cmds("forge_push_and_create_pr")).toHaveLength(0);
    // Let the push settle, or its promise outlives the test.
    handlers["git://push-done"]?.forEach((fn) => fn({ payload: { repo: ROOT } }));
  });

  it("shows the pull request it just opened, with nobody pressing Refresh", async () => {
    // `forge_pr_for_branch` is deliberately still answering null here, which is
    // what a forge that has not caught up with its own create looks like. The
    // panel holds what the create handed back rather than the older answer.
    signIn();
    await open({ sync: SYNC, directPr: null, createdPr: pr({ number: 77 }) });
    await waitFor(() => expect(document.querySelector('[data-panel-state="noPrPushed"]')).toBeTruthy());

    fireEvent.click(button("Open a pull request"));
    const title = await screen.findByPlaceholderText("What this branch does");
    fireEvent.input(title, { target: { value: "Scope the panel to this branch" } });
    fireEvent.click(button("Open pull request"));

    await waitFor(() => expect(cmds("forge_push_and_create_pr")).toHaveLength(1));
    expect(cmds("forge_push_and_create_pr")[0].args).toMatchObject({
      projectPath: ROOT,
      newPr: { head: BRANCH, base: "main", draft: false },
    });
    await waitFor(() => expect(screen.getByText("#77")).toBeTruthy());
  });

  it("asks the agent about the branch's own files, not the working tree", async () => {
    // The Changes panel's copy of this request names what is uncommitted,
    // because that is what it is about. Here the work is already in commits and
    // the tree is usually clean, so naming it would tell the session this
    // branch changed nothing.
    signIn();
    selection = { sessionId: "s1", agent: "claude", profile: null, folderPath: ROOT } as Selection;
    await open({
      directPr: null,
      branchPaths: ["src/panels/Editor/PullRequests/PullsPanel.tsx"],
    });
    await waitFor(() => expect(document.querySelector('[data-panel-state="noPrPushed"]')).toBeTruthy());
    fireEvent.click(button("Open a pull request"));
    await screen.findByPlaceholderText("What this branch does");

    const sent: string[] = [];
    const onSend = (e: Event) => {
      const d = (e as CustomEvent<{ requestId: string; text: string }>).detail;
      sent.push(d.text);
      window.dispatchEvent(
        new CustomEvent(SEND_TO_SESSION_RESULT, {
          detail: { requestId: d.requestId, result: "sent" },
        }),
      );
    };
    window.addEventListener(SEND_TO_SESSION, onSend);
    fireEvent.click(button("Ask agent to draft"));
    await waitFor(() => expect(sent).toHaveLength(1));
    window.removeEventListener(SEND_TO_SESSION, onSend);

    // Against `origin/main`, never the local ref: a local base is whatever was
    // last pulled.
    expect(cmds("git_branch_paths")[0].args).toMatchObject({
      projectPath: ROOT,
      base: "origin/main",
    });
    expect(sent[0]).toContain("PullsPanel.tsx");
    expect(sent[0]).toContain(BRANCH);
    expect(sent[0]).toContain("main");
  });

  it("names the browser when a form is not the route it would take", async () => {
    // The window before this repo's account has resolved: nothing is paused, so
    // the states still render, but `prPath` cannot promise a form yet. The
    // label follows that decision rather than being written once and hoped for.
    signIn();
    await open({ accountPending: true, directPr: null });
    await waitFor(() => expect(document.querySelector('[data-panel-state="noPrPushed"]')).toBeTruthy());

    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    fireEvent.click(button("Open compare on github.com"));

    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(String(opened.mock.calls[0][0])).toContain("/compare/main...wave-3");
    expect(screen.queryByPlaceholderText("What this branch does")).toBeNull();
    opened.mockRestore();
  });
});

// How the panel is reached. A registered command with no caller is not shipped,
// and the mirror of that is a panel with no way in: the mode strip collapses
// into an overflow menu on a narrow pane, so the palette is the reliable route
// (`lesson_a_registered_command_with_no_caller_is_not_shipped`).

describe("the keyboard", () => {
  const rows = () => [...document.querySelectorAll<HTMLElement>("[data-file-row]")];
  const panel = () => document.querySelector<HTMLElement>("[class*=panel]")!;

  async function threeFiles() {
    signIn();
    await open({
      statuses: [unit()],
      files: [file(), file({ path: "src/utils/forgeStatus.ts" }), file({ path: "src/utils/prUrl.ts" })],
    });
    await pollNow("manual");
    await waitFor(() => expect(rows()).toHaveLength(3));
  }

  it("walks the file list on j and k, and stops at both ends", async () => {
    await threeFiles();

    // Nothing focused yet, so the first press lands on the first row rather
    // than doing nothing: a key that appears dead is a key nobody presses twice.
    fireEvent.keyDown(panel(), { key: "j" });
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(panel(), { key: "j" });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(panel(), { key: "k" });
    expect(document.activeElement).toBe(rows()[0]);

    // Clamped, not wrapped. A list that jumps from its last row back to its
    // first gives a reader holding j no way to feel the end of the review.
    fireEvent.keyDown(panel(), { key: "k" });
    expect(document.activeElement).toBe(rows()[0]);
    for (let i = 0; i < 5; i++) fireEvent.keyDown(panel(), { key: "j" });
    expect(document.activeElement).toBe(rows()[2]);
  });

  it("opens the focused row on Enter and on Space", async () => {
    await threeFiles();
    fireEvent.keyDown(panel(), { key: "j" });
    fireEvent.keyDown(panel(), { key: "j" });

    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, (e) => opened.push(e.path));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    fireEvent.keyDown(document.activeElement!, { key: " " });
    off();

    // Both, and both the focused row's: the row is a button, and Enter and
    // Space are what a button does.
    expect(opened).toEqual([
      prDiffTabId(ROOT, 42, "src/utils/forgeStatus.ts"),
      prDiffTabId(ROOT, 42, "src/utils/forgeStatus.ts"),
    ]);
  });

  it("leaves j and k alone when they are being typed, or carry a modifier", async () => {
    await threeFiles();
    fireEvent.keyDown(panel(), { key: "j" });
    const first = document.activeElement;

    // Every review surface holds a text box, so a bare letter that moved the
    // focus while somebody was writing would be unusable. The panel's own
    // create-PR form is inside this element.
    const box = document.createElement("textarea");
    panel().appendChild(box);
    fireEvent.keyDown(box, { key: "j" });
    expect(document.activeElement).toBe(first);
    box.remove();

    // And Cmd+J belongs to the app, not to a list of files.
    fireEvent.keyDown(panel(), { key: "j", metaKey: true });
    expect(document.activeElement).toBe(first);
  });
});

describe("accessibility", () => {
  /// Every state the panel can be in, and the least that puts it there.
  ///
  /// A table rather than a test each, because what is being checked is the same
  /// thing about all of them: a state that draws a headline nobody can reach, a
  /// button with no name, or a colour carrying a fact on its own is a state that
  /// looks finished. The empty states share one block of markup, so the part
  /// that actually differs between these rows is which controls it offers.
  const STATES: { state: string; go: () => ReturnType<typeof open> }[] = [
    {
      state: "paused",
      go: async () => {
        noteForgeEnabled(false);
        noteAuth({ kind: "signedIn", login: "skarif2" });
        return open();
      },
    },
    {
      state: "paused",
      go: async () => {
        noteAuth({ kind: "signedOut" });
        return open();
      },
    },
    {
      state: "paused",
      go: async () => {
        noteAuth({ kind: "suspect", login: "skarif2" });
        noteForgeEnabled(true);
        return open();
      },
    },
    {
      state: "paused",
      go: async () => {
        signIn();
        return open({ repoAccount: { kind: "pick", host: "github.com", candidates: [] } });
      },
    },
    {
      state: "noBranch",
      go: async () => {
        signIn();
        return open({ branch: null });
      },
    },
    {
      state: "noRemote",
      go: async () => {
        signIn();
        return open({ origin: null });
      },
    },
    {
      state: "inert",
      go: async () => {
        signIn();
        return open({ origin: "git@bitbucket.org:skarif2/tori.git" });
      },
    },
    {
      state: "onBase",
      go: async () => {
        signIn();
        return open({ branch: "main", sync: { ...SYNC, base: null } });
      },
    },
    {
      state: "noPrUnpushed",
      go: async () => {
        signIn();
        return open({
          sync: {
            ...SYNC,
            upstream: { ahead: 3, behind: 0, has_upstream: true, gone: false, rewritten: false, superseded: false },
          },
        });
      },
    },
    {
      state: "noPrPushed",
      go: async () => {
        signIn();
        return open();
      },
    },
    {
      state: "error",
      go: async () => {
        signIn();
        return open({ directPrFails: { kind: "http", message: "GitHub said no." } });
      },
    },
    // The direct read left hanging, which is the window every branch the poll
    // has not reached yet sits in.
    {
      state: "loading",
      go: async () => {
        signIn();
        return open({ directPrPending: true });
      },
    },
  ];

  it("gives every empty state a name a screen reader can read", async () => {
    for (const { state, go } of STATES) {
      resetForgeStatusForTests();
      noteForgeEnabled(true);
      const view = await go();
      await waitFor(() =>
        expect(
          document.querySelector(`[data-panel-state="${state}"]`),
          `expected the panel to be in ${state}`,
        ).toBeTruthy(),
      );
      // `document.body`, not the render container: a tooltip portals out of it.
      await expectNoAxeViolations(document.body);
      view.unmount();
    }
  });

  it("gives the loaded panel one, with its files, checks and merge control", async () => {
    // The state with every control in it: the three verdict rows, the expanded
    // checks list, the merge bar, the file rows and the review footer. The
    // others are one block of markup with different sentences in it.
    signIn();
    notePr(ROOT, 42, pr());
    addPending(ROOT, 42, {
      path: "src/utils/forgeChip.ts",
      line: 1,
      side: "RIGHT",
      startLine: null,
      startSide: null,
      body: "a held remark",
      rowText: "+b",
    });
    await open({
      statuses: [
        unit({
          reviewDecision: "changesRequested",
          checks: {
            state: "failure",
            total: 2,
            failing: 1,
            contexts: [{ name: "build", state: "failure", url: "https://ci.test/1" }],
          },
        }),
      ],
      files: [file()],
      summary: summaryOf("dirty"),
      threads: [
        {
          id: "t1",
          path: "src/utils/forgeChip.ts",
          line: 4,
          startLine: null,
          diffHunk: "",
          isResolved: false,
          isOutdated: false,
          comments: [],
        },
      ],
    });
    await pollNow("manual");
    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());
    fireEvent.click(screen.getByText(/of 2 checks failing/));
    await waitFor(() => expect(screen.getByText("build")).toBeTruthy());

    await expectNoAxeViolations(document.body);
  });
});

describe("the ways into the panel", () => {
  it("has a palette command that switches the right pane to it", async () => {
    const { COMMANDS } = await import("../../../utils/commands");
    const cmd = COMMANDS.find((c) => c.id === "mode:pulls");
    expect(cmd, "no palette command opens the Pull Requests panel").toBeTruthy();
    expect(cmd!.label).toBe("Show Pull requests");

    let detail: unknown = null;
    const handler = (e: Event) => (detail = (e as CustomEvent).detail);
    window.addEventListener("tori:set-right-mode", handler);
    cmd!.run!({} as never);
    window.removeEventListener("tori:set-right-mode", handler);

    expect(detail).toEqual({ mode: "pulls" });
  });
});
