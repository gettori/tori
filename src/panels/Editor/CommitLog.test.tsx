import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The commit log tab: what it shows, where the header numbers come from, and how
// it walks a history longer than one page.

const REPO = "/proj";

type Row = { sha: string; short: string; subject: string; author: string; relative_date: string; refs: string[] };

const commit = (n: number, refs: string[] = []): Row => ({
  sha: `${n}`.repeat(40),
  short: `${n}`.repeat(7),
  subject: `commit ${n}`,
  author: "Sk Arif",
  relative_date: `${n} minutes ago`,
  refs,
});

let pages: Row[][] = [];
let logArgs: { skip: number; limit: number; file?: string }[] = [];
let logFails = "";
// With `holdLog` on, every `git_log` hangs until the test resolves it by hand,
// which is the only way to have two loads genuinely in flight at once.
let holdLog = false;
let pending: ((rows: Row[]) => void)[] = [];
let aheadBehind: { ahead: number; behind: number; has_upstream: boolean } | null = null;
let branches: { name: string; current: boolean }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "git_log": {
        logArgs.push({
          skip: Number(args.skip),
          limit: Number(args.limit),
          file: args.file as string | undefined,
        });
        if (logFails) return Promise.reject(logFails);
        if (holdLog) return new Promise<Row[]>((resolve) => pending.push(resolve));
        return Promise.resolve(pages.shift() ?? []);
      }
      case "list_branches":
        return Promise.resolve(branches);
      case "git_ahead_behind":
        return Promise.resolve(aheadBehind);
      case "git_status":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: CommitLog } = await import("./CommitLog");
const { refreshGit, refreshStatus } = await import("../../utils/gitActions");
const { onWith, OPEN_IN_EDITOR } = await import("../../utils/events");
const { parseSyntheticId } = await import("../../utils/syntheticTabs");

/** Fill the store for `REPO`, then mount the tab against it. */
async function mount(workspace = REPO, file?: string) {
  await refreshGit(REPO);
  render(() => <CommitLog workspace={workspace} file={file} />);
}

beforeEach(async () => {
  await refreshStatus(null);
  pages = [];
  logArgs = [];
  logFails = "";
  holdLog = false;
  pending = [];
  aheadBehind = null;
  branches = [];
});

describe("the commit log tab", () => {
  it("shows the branch and its ahead/behind beside the history", async () => {
    branches = [{ name: "wave-2", current: true }];
    aheadBehind = { ahead: 2, behind: 1, has_upstream: true };
    pages = [[commit(1, ["HEAD -> wave-2", "tag: v1"]), commit(2)]];

    await mount();

    // The header answers "where am I", which is the reason to open the log at
    // all rather than reading `git log` in a terminal.
    await waitFor(() => expect(screen.getByText("wave-2")).toBeTruthy());
    expect(screen.getByText("↑2 ↓1")).toBeTruthy();

    expect(screen.getByText("commit 1")).toBeTruthy();
    expect(screen.getByText("HEAD -> wave-2")).toBeTruthy();
    expect(screen.getByText("tag: v1")).toBeTruthy();
    // The undecorated commit beside it carries no chips at all.
    expect(screen.getByText("commit 2")).toBeTruthy();
  });

  it("says the branch is unpushed rather than showing numbers for nothing", async () => {
    branches = [{ name: "local-only", current: true }];
    aheadBehind = { ahead: 0, behind: 0, has_upstream: false };
    pages = [[commit(1)]];

    await mount();

    await waitFor(() => expect(screen.getByText("Unpushed branch")).toBeTruthy());
  });

  it("reads the store only when it is describing this workspace", async () => {
    // A tab for a branch-unit that is not the selected one must not label its
    // history with the selected unit's branch.
    branches = [{ name: "wave-2", current: true }];
    aheadBehind = { ahead: 2, behind: 1, has_upstream: true };
    pages = [[commit(1)]];

    await mount("/other");

    await waitFor(() => expect(screen.getByText("commit 1")).toBeTruthy());
    expect(screen.queryByText("wave-2")).toBeNull();
    expect(screen.queryByText("↑2 ↓1")).toBeNull();
    expect(logArgs[0]).toMatchObject({ skip: 0 });
  });

  it("pages through a history longer than one page, and stops at the end", async () => {
    const page = Array.from({ length: 100 }, (_, i) => commit(i + 1));
    pages = [page, [commit(101)]];

    await mount();
    await waitFor(() => expect(screen.getByText("commit 1")).toBeTruthy());

    // A full page means there may be more; a short one means there is not.
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("commit 101")).toBeTruthy());
    expect(logArgs).toEqual([
      { skip: 0, limit: 100 },
      { skip: 100, limit: 100 },
    ]);
    // Still showing the first page: a page appends, it does not replace.
    expect(screen.getByText("commit 1")).toBeTruthy();
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("offers no Load more when the first page is already the whole history", async () => {
    pages = [[commit(1)]];
    await mount();
    await waitFor(() => expect(screen.getByText("commit 1")).toBeTruthy());
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("shows git's own complaint instead of an empty history", async () => {
    logFails = "fatal: not a git repository";
    await mount();
    await waitFor(() => expect(screen.getByText("fatal: not a git repository")).toBeTruthy());
    expect(screen.queryByText("No commits yet.")).toBeNull();
  });

  it("reloads when HEAD moves, and not when a file is merely saved", async () => {
    branches = [{ name: "wave-2", current: true }];
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    pages = [[commit(1)], [commit(2)]];
    await mount();
    await waitFor(() => expect(logArgs.length).toBe(1));

    // What a watcher burst runs. It rewrites the store's file list, and the log
    // has nothing to learn from it - refetching here would put a `git log` on
    // every keystroke-driven save.
    await refreshStatus(REPO);
    await refreshStatus(REPO);
    expect(logArgs.length).toBe(1);

    // A commit, by contrast, re-reads the branch metadata, and the log is stale
    // the moment it does.
    aheadBehind = { ahead: 1, behind: 0, has_upstream: true };
    await refreshGit(REPO);
    await waitFor(() => expect(logArgs.length).toBe(2));
  });

  it("lets a reload that lands mid-fetch supersede the one already in flight", async () => {
    // A commit made from the Changes panel while the first page is still
    // loading. Refusing to start the second load would leave the log showing
    // pre-commit history until something else happened to move HEAD.
    branches = [{ name: "wave-2", current: true }];
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    holdLog = true;
    await mount();
    await waitFor(() => expect(pending.length).toBe(1));

    aheadBehind = { ahead: 1, behind: 0, has_upstream: true };
    await refreshGit(REPO);
    await waitFor(() => expect(pending.length).toBe(2));

    // The superseded answer comes back last, and must not win the race it lost.
    pending[1]([commit(2)]);
    pending[0]([commit(1)]);

    await waitFor(() => expect(screen.getByText("commit 2")).toBeTruthy());
    expect(screen.queryByText("commit 1")).toBeNull();
  });

  it("says so plainly when the repo has no commits", async () => {
    pages = [[]];
    await mount();
    await waitFor(() => expect(screen.getByText("No commits yet.")).toBeTruthy());
  });

  it("opens a commit tab for the row that was clicked", async () => {
    // The log's only way onward. The id carries the tab's own workspace, not
    // the selected one, so a background unit's log opens its own commits.
    pages = [[commit(1), commit(2)]];
    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, (d) => opened.push(d.path));
    await mount();

    fireEvent.click(await screen.findByText("commit 2"));

    expect(opened.length).toBe(1);
    expect(parseSyntheticId(opened[0])).toEqual({ kind: "commit", arg: commit(2).sha, workspace: REPO });
    off();
  });

  it("shows one file's history when given a file, and says it follows renames", async () => {
    branches = [{ name: "wave-2", current: true }];
    aheadBehind = { ahead: 2, behind: 1, has_upstream: true };
    pages = [[commit(1)]];

    await mount(REPO, "src/panels/Editor/Editor.tsx");

    await waitFor(() => expect(screen.getByText("commit 1")).toBeTruthy());
    expect(logArgs[0]).toMatchObject({ skip: 0, file: "src/panels/Editor/Editor.tsx" });
    expect(screen.getByText("src/panels/Editor/Editor.tsx")).toBeTruthy();
    // Worth saying: rows from before a rename name a path the file no longer
    // has, which is confusing unless the header admits it.
    expect(screen.getByText("following renames")).toBeTruthy();
    // The branch header belongs to the branch log, not to this one.
    expect(screen.queryByText("↑2 ↓1")).toBeNull();
  });

  it("says nothing touched the file rather than that the repo is empty", async () => {
    pages = [[]];
    await mount(REPO, "src/gone.ts");
    await waitFor(() => expect(screen.getByText("No commits touch this file.")).toBeTruthy());
  });
});
