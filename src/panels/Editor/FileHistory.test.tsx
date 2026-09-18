import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

// One file's history tab: what it shows, which workspace it follows, and how it
// walks a history longer than one page.

const REPO = "/proj";
const FILE = "src/panels/Editor/Editor.tsx";

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

const { default: FileHistory } = await import("./FileHistory");
const { enterRoots, refreshGit, refreshStatus } = await import("../../utils/gitActions");
const { onWith, OPEN_IN_EDITOR } = await import("../../utils/events");
const { parseSyntheticId } = await import("../../utils/syntheticTabs");

/** Fill the store for `REPO`, then mount the tab against it. */
async function mount(workspace = REPO, file = FILE) {
  await refreshGit(REPO);
  render(() => <FileHistory workspace={workspace} file={file} />);
}

beforeEach(async () => {
  enterRoots([REPO]);
  pages = [];
  logArgs = [];
  logFails = "";
  holdLog = false;
  pending = [];
  aheadBehind = null;
  branches = [];
});

describe("one file's history tab", () => {
  it("names the file it is following, and asks git for that pathspec", async () => {
    pages = [[commit(1, ["HEAD -> wave-2", "tag: v1"]), commit(2)]];

    await mount();

    await waitFor(() => expect(screen.getByText("commit 1")).toBeTruthy());
    expect(logArgs[0]).toMatchObject({ skip: 0, file: FILE });
    expect(screen.getByText(FILE)).toBeTruthy();
    // Worth saying: rows from before a rename name a path the file no longer
    // has, which is confusing unless the header admits it.
    expect(screen.getByText("following renames")).toBeTruthy();

    expect(screen.getByText("HEAD -> wave-2")).toBeTruthy();
    expect(screen.getByText("tag: v1")).toBeTruthy();
    // The undecorated commit beside it carries no chips at all.
    expect(screen.getByText("commit 2")).toBeTruthy();
  });

  it("follows its own member's HEAD while another member is in front", async () => {
    // Inside a Topic every member is a repo of its own, so a history tab opened
    // on one must follow that one - which is what reading a single shared slot
    // got wrong.
    const OTHER = "/other";
    branches = [{ name: "wave-2", current: true }];
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    pages = [[commit(1)], [commit(2)]];
    enterRoots([REPO, OTHER], REPO);
    await refreshGit(OTHER);
    render(() => <FileHistory workspace={OTHER} file={FILE} />);
    await waitFor(() => expect(logArgs.length).toBe(1));

    // A commit in the member that happens to be in front says nothing about
    // the history this tab is showing.
    aheadBehind = { ahead: 1, behind: 0, has_upstream: true };
    await refreshGit(REPO);
    expect(logArgs.length).toBe(1);

    await refreshGit(OTHER);
    await waitFor(() => expect(screen.getByText("commit 2")).toBeTruthy());
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
      { skip: 0, limit: 100, file: FILE },
      { skip: 100, limit: 100, file: FILE },
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
    expect(screen.queryByText("No commits touch this file.")).toBeNull();
  });

  it("reloads when HEAD moves, and not when a file is merely saved", async () => {
    branches = [{ name: "wave-2", current: true }];
    aheadBehind = { ahead: 0, behind: 0, has_upstream: true };
    pages = [[commit(1)], [commit(2)]];
    await mount();
    await waitFor(() => expect(logArgs.length).toBe(1));

    // What a watcher burst runs. It rewrites the store's file list, and the list
    // has nothing to learn from it - refetching here would put a `git log` on
    // every keystroke-driven save.
    await refreshStatus(REPO);
    await refreshStatus(REPO);
    expect(logArgs.length).toBe(1);

    // A commit, by contrast, re-reads the branch metadata, and the list is stale
    // the moment it does.
    aheadBehind = { ahead: 1, behind: 0, has_upstream: true };
    await refreshGit(REPO);
    await waitFor(() => expect(logArgs.length).toBe(2));
  });

  it("lets a reload that lands mid-fetch supersede the one already in flight", async () => {
    // A commit made from the Changes panel while the first page is still
    // loading. Refusing to start the second load would leave the list showing
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

  it("says nothing touched the file rather than that the repo is empty", async () => {
    pages = [[]];
    await mount(REPO, "src/gone.ts");
    await waitFor(() => expect(screen.getByText("No commits touch this file.")).toBeTruthy());
  });

  it("opens a commit tab for the row that was clicked", async () => {
    // The list's only way onward. The id carries the tab's own workspace, not
    // the selected one, so a background unit's history opens its own commits.
    pages = [[commit(1), commit(2)]];
    const opened: string[] = [];
    const off = onWith<{ path: string }>(OPEN_IN_EDITOR, (d) => opened.push(d.path));
    await mount();

    fireEvent.click(await screen.findByText("commit 2"));

    expect(opened.length).toBe(1);
    expect(parseSyntheticId(opened[0])).toEqual({ kind: "commit", arg: commit(2).sha, workspace: REPO });
    off();
  });
});

describe("one file's history, to axe", () => {
  it("has no accessibility violations", async () => {
    branches = [{ name: "wave-2", current: true }];
    aheadBehind = { ahead: 2, behind: 1, has_upstream: true };
    pages = [[commit(1, ["HEAD -> wave-2"]), commit(2)]];
    await mount();
    await waitFor(() => expect(screen.getByText("commit 1")).toBeTruthy());

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });
});
